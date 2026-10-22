import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { rollup } from "rollup";

const source = new URL("./public/", import.meta.url);
const destination = new URL("../docs/", import.meta.url);
const bundle = await rollup({
  input: fileURLToPath(new URL("app.js", source)),
});
let javascript;
try {
  const { output } = await bundle.generate({ format: "iife" });
  javascript = output[0].code.replace(/<\/script/giu, "<\\/script");
} finally {
  await bundle.close();
}
const css = (await readFile(new URL("styles.css", source), "utf8")).replace(
  /<\/style/giu,
  "<\\/style",
);
const digest = createHash("sha256").update(javascript).digest("base64");
const policy = `default-src 'none'; script-src 'sha256-${digest}'; style-src 'unsafe-inline'; img-src data: blob:; connect-src https: http:; object-src 'none'; base-uri 'none'; form-action 'none'`;
let html = await readFile(new URL("index.html", source), "utf8");
if (!html.includes('src="./app.js"') || !html.includes('href="./styles.css"'))
  throw new Error("Expected relative public asset entries.");
html = html
  .replace(/<html([^>]*)>/u, '<html$1 data-mode="browser">')
  .replace(
    /<link rel="stylesheet" href="\.\/styles\.css"\s*\/>/u,
    `<style>${css}</style>`,
  )
  .replace(/<script type="module" src="\.\/app\.js"><\/script>/u, "")
  .replace(
    "</head>",
    `<meta http-equiv="Content-Security-Policy" content="${policy}" />\n</head>`,
  )
  .replace("</body>", `<script>${javascript}</script>\n</body>`);
await mkdir(destination, { recursive: true });
await writeFile(new URL("index.html", destination), html);
await writeFile(new URL(".nojekyll", destination), "");
console.log(
  `已生成独立网页 docs/index.html（${Buffer.byteLength(html).toLocaleString()} bytes）`,
);
