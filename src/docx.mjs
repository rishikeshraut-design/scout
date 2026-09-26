// A minimal .docx writer: enough OOXML to carry this one layout, and no more.
//
// Decision 003 keeps this project at zero dependencies, and decision 006 lists
// what the resume layout actually needs — paragraphs, runs, tab stops, external
// hyperlinks, section properties and a bullet list. That subset is small enough
// to emit directly. A .docx is a ZIP of XML parts, so the only real work here is
// the ZIP container; Node ships zlib, which covers the rest.
//
// Reopen the "add a document library" trade explicitly if this file starts
// growing features. It is deliberately not a general-purpose writer.

import zlib from 'node:zlib';

// ── ZIP ────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Build a ZIP from [{ name, data }]. Entries are deflated; a .docx is read by
 * Word, Docs and every unzip implementation with plain deflate, so there is no
 * reason to store uncompressed.
 */
export function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  // A fixed timestamp keeps two runs of the same selection byte-identical,
  // which is what makes "did the document actually change?" answerable.
  const dosTime = 0;
  const dosDate = (2020 - 1980) << 9 | (1 << 5) | 1;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(8, 8);             // method: deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra length
    nameBuf.copy(local, 30);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);               // version made by
    cd.writeUInt16LE(20, 6);               // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);               // extra
    cd.writeUInt16LE(0, 32);               // comment
    cd.writeUInt16LE(0, 34);               // disk number
    cd.writeUInt16LE(0, 36);               // internal attrs
    cd.writeUInt32LE(0, 38);               // external attrs
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);

    locals.push(local, comp);
    central.push(cd);
    offset += local.length + comp.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cdBuf, eocd]);
}

// ── XML helpers ────────────────────────────────────────────────────────────
export const x = s =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const XMLNS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const XMLNS_R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/**
 * A run. size is in points; OOXML wants half-points, so it is doubled here and
 * callers can stay in the units decision 006 is written in.
 */
export function run(text, { size = 10.5, bold = false, caps = false, color = null, spacing = null } = {}) {
  const props = [
    bold ? '<w:b/>' : '',
    caps ? '<w:caps/>' : '',
    color ? `<w:color w:val="${color}"/>` : '',
    spacing ? `<w:spacing w:val="${spacing}"/>` : '',
    `<w:sz w:val="${Math.round(size * 2)}"/>`,
    `<w:szCs w:val="${Math.round(size * 2)}"/>`,
  ].join('');
  // xml:space="preserve" or Word eats the spaces around a tab.
  return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${x(text)}</w:t></w:r>`;
}

export const tab = () => '<w:r><w:tab/></w:r>';

/**
 * An external hyperlink. `relId` must be registered in the links array passed to
 * docx(), which is what writes the matching relationship into document.xml.rels.
 * Docs and Word both need the relationship — a bare w:hyperlink with no r:id is
 * dropped silently on import.
 */
export const hyperlink = (relId, runs) =>
  `<w:hyperlink r:id="${relId}">${Array.isArray(runs) ? runs.join('') : runs}</w:hyperlink>`;

/**
 * A paragraph. `tabStop` places a single right-aligned tab (twips), which is
 * how dates right-align without a table — decision 006 forbids a table in the
 * single-column layout because line-by-line extractors scramble them.
 */
export function para(runs, { before = 0, after = 0, tabStop = null, bullet = false, indent = null, rule = false, keepNext = false } = {}) {
  const pr = [
    bullet ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : '',
    tabStop ? `<w:tabs><w:tab w:val="right" w:pos="${tabStop}"/></w:tabs>` : '',
    indent ? `<w:ind w:left="${indent.left || 0}" w:hanging="${indent.hanging || 0}"/>` : '',
    `<w:spacing w:before="${before}" w:after="${after}" w:line="240" w:lineRule="auto"/>`,
    rule ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="1A1A1A"/></w:pBdr>' : '',
    keepNext ? '<w:keepNext/>' : '',
  ].join('');
  return `<w:p><w:pPr>${pr}</w:pPr>${Array.isArray(runs) ? runs.join('') : runs}</w:p>`;
}

// ── the package ────────────────────────────────────────────────────────────
const CONTENT_TYPES = `${DECL}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

const RELS = `${DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const docRels = (links = []) => `${DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
${links.map(l => `<Relationship Id="${x(l.id)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${x(l.url)}" TargetMode="External"/>`).join('\n')}
</Relationships>`;

const numbering = () => `${DECL}
<w:numbering ${XMLNS}>
<w:abstractNum w:abstractNumId="0">
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/>
<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="216" w:hanging="216"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:hint="default"/></w:rPr></w:lvl>
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

const styles = font => `${DECL}
<w:styles ${XMLNS}>
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="${x(font)}" w:hAnsi="${x(font)}" w:cs="${x(font)}"/>
<w:sz w:val="21"/><w:szCs w:val="21"/><w:color w:val="1A1A1A"/>
</w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>`;

/** Letter, 0.5in margins (720 twips) — decision 006. */
export const SECTION =
  '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>' +
  '<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="0" w:footer="0" w:gutter="0"/>' +
  '</w:sectPr>';

export function docx(bodyXml, font, links = []) {
  const document = `${DECL}
<w:document ${XMLNS} ${XMLNS_R}><w:body>${bodyXml}${SECTION}</w:body></w:document>`;
  return zip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: RELS },
    { name: 'word/_rels/document.xml.rels', data: docRels(links) },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: styles(font) },
    { name: 'word/numbering.xml', data: numbering() },
  ]);
}
