#!/usr/bin/env node
/**
 * Trump Truth Social post tracker.
 *
 * Truth Social itself blocks this environment (Cloudflare 403 / connection
 * reset), so posts are read from the trumpstruth.org archive, which mirrors
 * @realDonaldTrump in near real time and exposes an RSS feed.
 *
 * Chromium cannot CONNECT through the egress proxy here, so page rendering
 * uses Playwright route interception: the browser renders, while every
 * network request is fetched Node-side (which the proxy does allow).
 *
 * Usage:
 *   node tracker/check.js --outdir <dir> [--init] [--state <file>]
 *
 * Prints a JSON report to stdout:
 *   { initialized: true, latest: {...} }              on first run / --init
 *   { newPosts: [{id, url, originalUrl, title, text, pubDate, screenshot}] }
 *
 * State (last seen trumpstruth status id) lives in tracker/state.json.
 */

const fs = require('fs');
const path = require('path');
const { chromium, request } = require('playwright');

const FEED_URL = 'https://trumpstruth.org/feed';
const PROXY = process.env.HTTPS_PROXY;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    outdir: '.',
    init: false,
    state: path.join(__dirname, 'state.json'),
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--outdir') opts.outdir = args[++i];
    else if (args[i] === '--init') opts.init = true;
    else if (args[i] === '--state') opts.state = args[++i];
  }
  return opts;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');
}

function stripHtml(html) {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*<p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
  ).trim();
}

function parseFeed(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const grab = (re) => {
      const r = re.exec(block);
      return r ? r[1].trim() : '';
    };
    const link = grab(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/);
    const idMatch = /\/statuses\/(\d+)/.exec(link);
    if (!idMatch) continue;
    items.push({
      id: parseInt(idMatch[1], 10),
      url: link,
      title: stripHtml(grab(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)),
      text: stripHtml(grab(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)),
      pubDate: grab(/<pubDate>([\s\S]*?)<\/pubDate>/),
      originalUrl: grab(/<truth:originalUrl>([\s\S]*?)<\/truth:originalUrl>/),
      originalId: grab(/<truth:originalId>([\s\S]*?)<\/truth:originalId>/),
    });
  }
  return items;
}

async function fetchFeed() {
  const ctx = await request.newContext(PROXY ? { proxy: { server: PROXY } } : {});
  try {
    const res = await ctx.get(FEED_URL, { timeout: 60000 });
    if (!res.ok()) throw new Error(`feed HTTP ${res.status()}`);
    return await res.text();
  } finally {
    await ctx.dispose();
  }
}

async function screenshotPost(browserCtx, post, outdir) {
  const page = await browserCtx.newPage();
  try {
    await page.goto(post.url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(3000);
    // Drop images that failed to load (e.g. avatars hosted on blocked CDNs)
    await page.evaluate(() => {
      for (const img of document.querySelectorAll('img')) {
        if (!img.complete || img.naturalWidth === 0) img.style.display = 'none';
      }
    });
    const file = path.join(outdir, `truth-${post.id}.png`);
    const el = await page.$('.status');
    if (el) await el.screenshot({ path: file });
    else await page.screenshot({ path: file, fullPage: true });
    return file;
  } finally {
    await page.close();
  }
}

async function main() {
  const opts = parseArgs();
  fs.mkdirSync(opts.outdir, { recursive: true });

  const items = parseFeed(await fetchFeed());
  if (items.length === 0) throw new Error('feed parsed to zero items');
  items.sort((a, b) => b.id - a.id);
  const latest = items[0];

  let state = null;
  if (fs.existsSync(opts.state)) {
    state = JSON.parse(fs.readFileSync(opts.state, 'utf8'));
  }

  if (opts.init || !state) {
    fs.writeFileSync(
      opts.state,
      JSON.stringify({ lastId: latest.id, lastCheck: new Date().toISOString() }, null, 2) + '\n'
    );
    console.log(JSON.stringify({ initialized: true, latest }, null, 2));
    return;
  }

  const newPosts = items.filter((it) => it.id > state.lastId).reverse(); // oldest first

  if (newPosts.length > 0) {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const ctx = await browser.newContext(
      Object.assign(
        { viewport: { width: 800, height: 1400 } },
        PROXY ? { proxy: { server: PROXY } } : {}
      )
    );
    // Chromium's own connections are reset by the egress proxy; serve every
    // request from the Node-side network stack instead.
    await ctx.route('**/*', async (route) => {
      try {
        await route.fulfill({ response: await route.fetch() });
      } catch (e) {
        await route.abort().catch(() => {});
      }
    });
    for (const post of newPosts) {
      try {
        post.screenshot = await screenshotPost(ctx, post, opts.outdir);
      } catch (e) {
        post.screenshot = null;
        post.screenshotError = e.message.split('\n')[0];
      }
    }
    await browser.close();
  }

  fs.writeFileSync(
    opts.state,
    JSON.stringify({ lastId: latest.id, lastCheck: new Date().toISOString() }, null, 2) + '\n'
  );
  console.log(JSON.stringify({ newPosts }, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
});
