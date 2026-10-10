// Floor plans often come as PDFs: each page becomes a picture here, in the browser, before it's
// sent (the server only takes pictures). PDF.js loads only when someone picks a PDF.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/** The longest side of a page's picture (what the server keeps anyway). */
const SIDE = 3000;

export const isPdf = (file: File) =>
  file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

/** Each page of a PDF (up to `max`) as a PNG, white behind, its longest side 3,000 px. */
export async function pdfPages(file: File, max: number): Promise<File[]> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  // (PDF.js 6 draws fonts without eval, which the app's security policy doesn't allow.)
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (e) {
    await task.destroy();
    throw new Error(
      (e as Error).name === 'PasswordException'
        ? 'That PDF is locked with a password: save an unlocked copy and try again.'
        : "That PDF couldn't be opened.",
    );
  }
  const base = file.name.replace(/\.pdf$/i, '');
  const pages: File[] = [];
  try {
    for (let n = 1; n <= Math.min(doc.numPages, max); n++) {
      const page = await doc.getPage(n);
      const size = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: SIDE / Math.max(size.width, size.height) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, viewport, background: '#ffffff' }).promise;
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
      page.cleanup();
      if (!blob) throw new Error("A page of that PDF couldn't be drawn.");
      pages.push(new File([blob], `${base}-page-${n}.png`, { type: 'image/png' }));
    }
  } finally {
    await task.destroy();
  }
  return pages;
}
