/**
 * Screenshots of a running hub with headless Firefox (puppeteer-core, WebDriver BiDi).
 * Not a repo dependency: `npm i --no-save puppeteer-core` first.
 *
 *   U=demo P="show me around" FULL=0 W=1440 H=900 THEME=dark \
 *     node scripts/test/screenshots.mjs http://127.0.0.1:2470 out/ /=overview /i/1=dashboard
 *
 * FIREFOX: browser binary (snap Firefox: use /snap/firefox/current/usr/lib/firefox/firefox,
 * the /usr/bin/firefox wrapper can't use temporary profiles).
 */
import puppeteer from "puppeteer-core";

const [, , base, outDir, ...pages] = process.argv;
const browser = await puppeteer.launch({
	browser: "firefox",
	executablePath: process.env.FIREFOX ?? "/snap/firefox/current/usr/lib/firefox/firefox",
	headless: true,
});
const page = await browser.newPage();
await page.setViewport({ width: Number(process.env.W ?? 1440), height: Number(process.env.H ?? 1000) });
page.on("pageerror", (e) => console.log("page error:", e.message));
await page.goto(base, { waitUntil: "networkidle0" });
if (await page.$('input[autocomplete="username"]')) {
	await page.type('input[autocomplete="username"]', process.env.U ?? "admin");
	await page.type('input[type="password"]', process.env.P ?? "");
	await page.click('button[type="submit"]');
	await new Promise((r) => setTimeout(r, 1500));
}
const theme = async () => process.env.THEME && page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), process.env.THEME);
for (const p of pages) {
	const [path, name] = p.split("=");
	await page.goto(base + path, { waitUntil: "networkidle0" }).catch(() => {});
	await theme();
	await new Promise((r) => setTimeout(r, Number(process.env.WAIT ?? 2500)));
	await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: process.env.FULL !== "0" });
	console.log("shot", name);
}
await browser.close();
