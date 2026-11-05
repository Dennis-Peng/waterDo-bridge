// Public CI runs use synthetic fixtures only. Publish bounded failure diagnostics
// as annotations so maintainers can inspect failures without downloading logs.
import { relative } from 'node:path';
const escape = value => String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
export default async function* report(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const data = event.data, error = data.details?.error;
    const file = data.file ? relative(process.cwd(), data.file) : '';
    const detail = `${data.name}: ${error?.cause?.message ?? error?.message ?? 'test failed'}`.slice(0, 4000);
    yield `::error file=${escape(file)},line=${Number.isSafeInteger(data.line) ? data.line : 1}::${escape(detail)}\n`;
  }
}
