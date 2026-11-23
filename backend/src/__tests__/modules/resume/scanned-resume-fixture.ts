import { createCanvas } from '@napi-rs/canvas';
import { deflateSync } from 'node:zlib';

const WIDTH = 1_200;
const HEIGHT = 1_500;
export type RasterPage = string[][];

/** Write a PDF whose pages contain only raster images, with no text layer. */
export function scanPdf(pages: RasterPage[]): Buffer {
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] >>`),
  ];
  function stream(dict: string, contents: Buffer) {
    return Buffer.concat([Buffer.from(`<< ${dict} /Length ${contents.length} >>\nstream\n`), contents, Buffer.from('\nendstream')]);
  }
  for (const [index, columns] of pages.entries()) {
    const firstId = 3 + index * 3;
    const canvas = createCanvas(WIDTH, HEIGHT);
    const context = canvas.getContext('2d');
    context.fillStyle = 'white';
    context.fillRect(0, 0, WIDTH, HEIGHT);
    context.fillStyle = 'black';
    context.font = `${columns.length === 1 ? 42 : 26}px sans-serif`;
    columns.forEach((column, col) => {
      column.forEach((line, row) => context.fillText(line, 80 + col * 620, 150 + row * 76));
    });
    const rgba = context.getImageData(0, 0, WIDTH, HEIGHT).data;
    const grayscale = Buffer.alloc(WIDTH * HEIGHT);
    for (let i = 0; i < grayscale.length; i += 1) grayscale[i] = rgba[i * 4];
    objects.push(
      Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 750] /Resources << /XObject << /Scan ${firstId + 2} 0 R >> >> /Contents ${firstId + 1} 0 R >>`),
      stream('', Buffer.from('q 600 0 0 750 0 0 cm /Scan Do Q')),
      stream(`/Type /XObject /Subtype /Image /Width ${WIDTH} /Height ${HEIGHT} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, deflateSync(grayscale)),
    );
  }
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = ['0000000000 65535 f \n'];
  let cursor = chunks[0].length;
  objects.forEach((body, index) => {
    offsets.push(`${String(cursor).padStart(10, '0')} 00000 n \n`);
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
    chunks.push(object);
    cursor += object.length;
  });
  chunks.push(Buffer.from(`xref\n0 ${offsets.length}\n${offsets.join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
