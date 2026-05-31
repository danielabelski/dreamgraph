import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { marked } from "marked";

const root = resolve(import.meta.dirname, "..");
const markdownPath = resolve(root, "docs", "easy-start.md");
const htmlPath = resolve(root, "docs", "easy-start.html");
const markdown = await readFile(markdownPath, "utf-8");
const body = await marked.parse(markdown);

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DreamGraph Easy Start</title>
  <style>
    :root { color-scheme: light; font-family: Inter, system-ui, sans-serif; line-height: 1.55; color: #172033; }
    body { max-width: 920px; margin: 0 auto; padding: 40px 28px 72px; }
    h1, h2, h3 { color: #101827; line-height: 1.2; }
    h1 { font-size: 2.25rem; }
    h2 { margin-top: 2rem; border-top: 1px solid #d9dfeb; padding-top: 1rem; }
    code { background: #eef2f7; border-radius: 4px; padding: 0.12rem 0.3rem; }
    pre { background: #101827; color: #f8fafc; border-radius: 8px; padding: 1rem; overflow-x: auto; }
    pre code { background: transparent; padding: 0; }
    blockquote { margin: 1rem 0; padding: 0.7rem 1rem; background: #f3f6fb; border-left: 4px solid #6d5dfc; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #d9dfeb; padding: 0.55rem; text-align: left; vertical-align: top; }
    th { background: #f3f6fb; }
    a { color: #5546d8; }
    @media print { body { max-width: none; padding: 20px; } a { color: inherit; text-decoration: none; } }
  </style>
</head>
<body>
${body}
</body>
</html>
`;

await writeFile(htmlPath, html, "utf-8");
console.log(`Generated ${htmlPath}`);
