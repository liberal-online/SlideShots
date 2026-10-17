/* Keep one stitched vertical image in compressed strips, then paginate it on portrait A4. */
globalThis.PdfWriter = class PdfWriter {
  constructor(width) {
    this.width = width;
    this.pixelWidth = Math.min(width, 1600);
    this.scale = this.pixelWidth / width;
    this.pageWidth = 595;
    this.pageHeight = 842;
    this.margin = 24;
    this.maxRows = Math.max(1, Math.floor((this.pageHeight - 2 * this.margin) * this.pixelWidth / (this.pageWidth - 2 * this.margin)));
    this.sourceHeight = 0;
    this.totalRows = 0;
    this.strips = [];
    this.pages = [];
  }

  static async compress(bytes) {
    return new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"))).blob();
  }

  async addBand(canvas, height) {
    const end = Math.round((this.sourceHeight + height) * this.scale);
    const rows = end - this.totalRows;
    this.sourceHeight += height;
    if (rows <= 0) return;
    let image = canvas;
    if (this.pixelWidth !== this.width || rows !== height) {
      image = new OffscreenCanvas(this.pixelWidth, rows);
      image.getContext("2d", { alpha: false }).drawImage(canvas, 0, 0, this.width, height, 0, 0, this.pixelWidth, rows);
    }
    const rgba = image.getContext("2d").getImageData(0, 0, this.pixelWidth, rows).data;
    const rgb = new Uint8Array(this.pixelWidth * rows * 3);
    const score = new Uint16Array(rows);
    const stride = Math.max(1, Math.floor(this.pixelWidth / 800));
    const edge = Math.floor(this.pixelWidth * .03);
    for (let y = 0; y < rows; y++) {
      let previousX = -1;
      for (let x = edge; x < this.pixelWidth - edge; x += stride) {
        const i = (y * this.pixelWidth + x) * 4;
        if (previousX >= 0) {
          const p = (y * this.pixelWidth + previousX) * 4;
          if (Math.max(Math.abs(rgba[i] - rgba[p]), Math.abs(rgba[i + 1] - rgba[p + 1]), Math.abs(rgba[i + 2] - rgba[p + 2])) > 24) score[y]++;
        }
        if (y > 0) {
          const p = ((y - 1) * this.pixelWidth + x) * 4;
          if (Math.max(Math.abs(rgba[i] - rgba[p]), Math.abs(rgba[i + 1] - rgba[p + 1]), Math.abs(rgba[i + 2] - rgba[p + 2])) > 24) score[y]++;
        }
        previousX = x;
      }
      for (let x = 0; x < this.pixelWidth; x++) {
        const i = (y * this.pixelWidth + x) * 4, o = (y * this.pixelWidth + x) * 3;
        rgb[o] = rgba[i]; rgb[o + 1] = rgba[i + 1]; rgb[o + 2] = rgba[i + 2];
      }
    }
    this.strips.push({ start: this.totalRows, end, compressed: await PdfWriter.compress(rgb), score, raw: null });
    this.totalRows = end;
    if (image !== canvas) { image.width = 1; image.height = 1; }
  }

  // Search backwards near the A4 limit for an uninterrupted low-detail row gap.
  findBreak(start, ideal, scores) {
    const first = Math.max(start + 1, ideal - Math.floor(this.maxRows * .5));
    let best = null, runStart = -1;
    for (let y = first; y <= ideal; y++) {
      if (y < ideal && scores[y] === 0) {
        if (runStart < 0) runStart = y;
      } else if (runStart >= 0) {
        const length = y - runStart;
        if (length >= 4) {
          const end = y === ideal ? ideal : Math.max(runStart + 2, y - 2);
          // A broad quiet area followed by a full-width color change is usually
          // the space between sections. Prefer it to padding inside a card.
          const transition = y < ideal ? Math.min(scores[y], 900) : 0;
          const rank = Math.min(length, 120) + transition * .12 + 10 * (end - first) / Math.max(1, ideal - first);
          if (!best || rank > best.rank) best = { end, rank };
        }
        runStart = -1;
      }
    }
    if (best) return { end: best.end, nextStart: best.end, safe: true };
    // A solid image or densely filled page has no gap. Repeat a narrow strip on
    // the next page so an item crossing the cut can still be read there in full.
    const overlap = this.maxRows >= 100 ? Math.min(48, Math.floor(this.maxRows * .04)) : 0;
    return { end: ideal, nextStart: ideal - overlap, safe: false };
  }

  async pagePixels(start, end) {
    const rowBytes = this.pixelWidth * 3;
    const pixels = new Uint8Array((end - start) * rowBytes);
    for (const strip of this.strips) {
      const from = Math.max(start, strip.start), to = Math.min(end, strip.end);
      if (from >= to) continue;
      if (!strip.raw) strip.raw = new Uint8Array(await new Response(strip.compressed.stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
      pixels.set(strip.raw.subarray((from - strip.start) * rowBytes, (to - strip.start) * rowBytes), (from - start) * rowBytes);
    }
    return pixels;
  }

  async finish() {
    if (!this.totalRows) throw new Error("PDFに配置する画像がありません。");
    const scores = new Uint16Array(this.totalRows);
    for (const strip of this.strips) scores.set(strip.score, strip.start);
    let start = 0;
    while (start < this.totalRows) {
      const ideal = Math.min(this.totalRows, start + this.maxRows);
      const cut = ideal === this.totalRows ? { end: ideal, nextStart: ideal, safe: true } : this.findBreak(start, ideal, scores);
      const pixels = await this.pagePixels(start, cut.end);
      this.pages.push({ width: this.pixelWidth, height: cut.end - start, sourceStart: start, sourceEnd: cut.end, safeBreak: cut.safe, compressed: await PdfWriter.compress(pixels) });
      start = cut.nextStart;
      for (const strip of this.strips) if (strip.end <= start) { strip.raw = null; strip.compressed = null; }
    }
    this.strips.length = 0;
    return this.serialize();
  }

  serialize() {
    const encode = (s) => new TextEncoder().encode(s);
    const parts = [], offsets = [0];
    let length = 0;
    const append = (part) => { parts.push(part); length += part.size ?? part.byteLength; };
    const add = (s) => append(encode(s));
    const object = (id, chunks) => {
      offsets[id] = length;
      add(`${id} 0 obj\n`);
      for (const chunk of chunks) append(typeof chunk === "string" ? encode(chunk) : chunk);
      add("\nendobj\n");
    };
    add("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    object(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
    const kids = this.pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
    object(2, [`<< /Type /Pages /Count ${this.pages.length} /Kids [${kids}] >>`]);
    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i], id = 3 + i * 3;
      const drawWidth = this.pageWidth - 2 * this.margin;
      const drawHeight = drawWidth * page.height / page.width;
      const y = this.pageHeight - this.margin - drawHeight;
      const command = encode(`q\n${drawWidth.toFixed(4)} 0 0 ${drawHeight.toFixed(4)} ${this.margin} ${y.toFixed(4)} cm\n/Im0 Do\nQ\n`);
      object(id, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.pageWidth} ${this.pageHeight}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`]);
      object(id + 1, [`<< /Length ${command.byteLength} >>\nstream\n`, command, "\nendstream"]);
      object(id + 2, [`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${page.compressed.size} >>\nstream\n`, page.compressed, "\nendstream"]);
    }
    const xref = length, count = 3 + this.pages.length * 3;
    add(`xref\n0 ${count}\n0000000000 65535 f \n`);
    for (let id = 1; id < count; id++) add(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
    add(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts, { type: "application/pdf" });
  }
};
