# Trump Truth Social Tracker

追蹤川普(@realDonaldTrump)在 Truth Social 上的新發文。

## 資料來源

Truth Social 本站(truthsocial.com)對此執行環境回傳 Cloudflare 403 / 連線重置,
無法直接存取。因此改用 [trumpstruth.org](https://trumpstruth.org) —— 一個近即時
同步川普 Truth Social 發文的公開存檔站,提供 RSS feed(`/feed`),其中含全文、
發文時間與原始 Truth Social 連結。

## 使用方式

```bash
export NODE_PATH=$(npm root -g)   # playwright 為全域安裝
node tracker/check.js --outdir /path/to/screenshots        # 例行檢查
node tracker/check.js --init                               # 重設基準點為最新一篇
```

輸出為 JSON:

- 首次執行 / `--init`:`{ "initialized": true, "latest": {...} }`
- 例行檢查:`{ "newPosts": [ { id, url, originalUrl, title, text, pubDate, screenshot } ] }`
  (無新文時 `newPosts` 為空陣列)

狀態(最後看過的文章 id)存於 `tracker/state.json`,每次執行後自動更新;
由排程任務負責 commit + push,讓狀態跨容器保存。

## 截圖機制

此環境的 egress proxy 會重置 Chromium 自己的連線,因此截圖使用 Playwright
路由攔截:Chromium 只負責渲染,所有網路請求改由 Node 端網路堆疊(可走 proxy)
代抓後回填。截圖擷取文章頁的 `.status` 元素,載入失敗的圖片(如被擋的頭像 CDN)
會自動隱藏。
