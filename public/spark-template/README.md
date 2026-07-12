# Shooting Lab 4DGS Spark Player — 觀看端參數說明 / Viewer URL Parameters

這個資料夾是一個自包含的 3D/4D Gaussian Splat 播放頁。上傳到任何靜態網站空間
(需 https 才能用 VR / 離線快取)後,直接開 `index.html` 即可觀看。
所有參數都加在網址後面,例如:

```
https://<host>/<path>/index.html?reveal=magic&revealsec=6&maxsh=0
```

優先順序:**網址參數 > 匯出時的選項(manifest.player)> 內建預設**。
不加任何參數 = 匯出時在編輯器選的行為。

## 參數一覽

| 參數 | 可用值 | 預設(未在匯出時另設) | 說明 |
|---|---|---|---|
| `reveal` | `spread` `magic` `unroll` `twister` `rain` `off` | `spread` | 進場特效。`off` = 直接顯示,不播特效 |
| `revealsec` | `0.5` ~ `20`(秒) | `4.5` | 進場特效長度,超出範圍會被夾住 |
| `campath` | `auto` `manual` `off` | `auto` | 相機路徑:`auto` 自動播放、`manual` 顯示 🎥 按鈕手動觸發、`off` 完全停用(沒匯出相機路徑的包無此功能) |
| `watermark` | `on` `off` | `on` | 場景內的 3D「Shooting Lab」浮水印(VR 內也看得到) |
| `zoom` | `adaptive` `default` `<min>-<max>` | `default` | 滑鼠/雙指縮放範圍:`adaptive` 依場景大小自適應、`default` 固定 0.4–2(單顆頭像適用)、自訂如 `zoom=0.1-50` |
| `offline` | `on` `off` | `off` | 離線快取(Service Worker):`on` 之後重複觀看不需重新下載大檔(需 https)。匯出時勾了 Offline cache 的包預設就是開的 |
| `maxsh` | `0` `1` `2` `3` | 不鉗制 | 上限球諧(SH)階數。含 SH3 物件(如 LiTo 生成物)的包在手機跑不動時,加 `maxsh=0` 直接降回純色渲染,不用重新匯出 |
| `arlight` | `on` `off` | 跟隨匯出設定(新匯出的包預設 on,經 `manifest.player.arLight`;舊包/未設定時預設 off) | AR 模式讀取手機環境光(Android),讓模型亮度/色溫貼合現場;Quest/不支援的裝置自動忽略 |

> 除錯:加 `arlightdebug=1` 可在桌面(不進 AR)強制開啟環境光分級,以合成的亮度/色溫/光向
> 慢速掃描驗證效果;與 `arlight` 開關無關,兩者可同時使用。

## 頁面上的控制

- **🔊**(左下)— 靜音/取消靜音(有音訊的包才會出現;設定會記住)
- **🎥** — 相機路徑播放/停止(`campath=manual` 或匯出選 Manual 時出現)
- **🕹** — 自由飛行模式(WASD + 滑鼠)/ 回到軌道環繞
- **VR / AR** — WebXR 進入鍵(需 https 與支援的裝置;VR 內可抓取整個場景移動)
- **手機 AR 手勢** — 單指拖曳 = 在地面上移動整個場景(上滑推遠、下滑拉近);雙指捏合 =
  縮放(捏合中可同時平移);**三指左右滑 = 旋轉場景**(轉盤式);Recenter 按鈕 = 拉回眼前重置
- 滑鼠拖曳 = 環繞;滾輪/雙指 = 縮放;右鍵拖曳 = 平移(`zoom=default` 時停用平移)

## 常用組合範例

```
?reveal=off                          跳過進場特效(排查問題時先用這個)
?maxsh=0                             手機效能救急:關掉視角反光
?campath=off&watermark=off           乾淨展示模式
?zoom=0.05-100                       完全放開縮放範圍
?offline=on                          強制開啟離線快取
?arlight=on                          舊包也強制開啟 AR 環境光(需支援的 Android 裝置)
```

---
Package format: manifest v2 (statics `.spz` + per-frame animated `.spz`, optional SH degree 3
on selected statics). Player: Spark (`@sparkjsdev/spark`) + three.js, vendored — no CDN needed.
© Shooting Lab Limited · slfpv.com
