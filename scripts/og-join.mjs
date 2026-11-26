// The link preview for meeting links (public/og-join.jpg): the home page's preview (public/og.jpg) with the line
// under "Meet" changed to an invitation. Run from the project folder after changing og.jpg:
//
//   node scripts/og-join.mjs public/og.jpg public/og-join.jpg

import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const [src, out] = process.argv.slice(2);
const data = readFileSync(src).toString("base64");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 628 } });
// .cover paints over the old line in the artwork's background colour, fading into the call window's glow.
await page.setContent(`<style>
  body { margin: 0; width: 1200px; height: 628px; position: relative; -webkit-font-smoothing: antialiased;
    background: url(data:image/jpeg;base64,${data}) 0 0 / 1200px 628px;
    font-family: -apple-system, "SF Pro Display", system-ui, sans-serif; }
  .cover { position: absolute; left: 55px; top: 392px; width: 382px; height: 96px;
    background: linear-gradient(90deg, #0f0f17 80%, #16172a);
    -webkit-mask-image: linear-gradient(90deg, #000 95%, transparent); }
  .t { position: absolute; left: 73px; top: 398px; font-size: 31px; line-height: 42px; font-weight: 600;
    letter-spacing: -.2px; color: #fff; }
  .t b { color: #8086f7; font-weight: 600; }
</style><div class="cover"></div><div class="t">You’re invited to a call<br><b>Tap to join</b></div>`);
await page.screenshot({ path: out, type: "jpeg", quality: 85 });
await browser.close();
