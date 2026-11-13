# 一水千田｜卡牌 WebAR 輔助提示（MVP）

用手機瀏覽器開網頁 → 掃一張卡 → 歷史人物站到卡上 → 示範一個容易搞錯的操作。免安裝 App，可放在 GitHub Pages。

---

## 1. 資料夾結構

```
yishui-ar/
├─ index.html                 頁面結構、CDN 版本（importmap）
├─ style.css                  介面樣式（直式手機、safe-area）
├─ app.js                     全部程式；最上方是卡牌設定 CARD_CONFIG
├─ README.md                  本文件
└─ assets/
   ├─ targets.mind            ★ 你要自己產生（見第 3 節）
   ├─ test-card_WaterIntake.png   測試用卡面（圖案多、好辨識）
   ├─ models/                 正式 .glb 人物（之後再放）
   └─ portraits/              對話框頭像（可省略）
```

**CDN 版本（彼此相容，不要只升級其中一個）**
- MindAR **1.2.5**（`mindar-image-three.prod.js`）
- Three.js **0.160.0**（MindAR 1.2.5 官方範例搭配的版本）
- es-module-shims 1.10.0：只在舊 iPhone（iOS 16.4 以前）不支援 importmap 時作用

---

## 2. 程式重點

| 需求 | 做法 |
|---|---|
| 辨識與錨點 | `mindarThree.addAnchor(targetIndex)`；人物放在自己的 follower 群組，每幀平滑追上卡牌位置，吸收手震 |
| 防閃爍 | `onTargetLost` 後先**暫停動畫、人物停在原地**；500 ms 內找回就從暫停處繼續；超過才縮小消失。下次找回時，示範從中斷處接著播 |
| 人物 | 預設是幾何體組成的戴斗笠小人；`character.model` 填 .glb 路徑就換成正式模型（自動縮放、腳底對齊、播放 `PlayDemo` 動畫） |
| 示範 | 水圳從取水口「長」到主幹渠，發光點沿線移動，人物抬手指著，終點閃三下；「重播示範」可重來 |
| 對話框 | 名稱標籤＋1～2 句提示，「下一句」翻頁，最後一句變「我知道了」；「收起提示」關掉 |
| 啟動與防呆 | 開始畫面按「開啟 AR 輔助掃描」才開相機；掃描引導框；右上「重新掃描」；權限被拒、非 https、找不到特徵檔都會顯示原因 |
| iOS | video 強制 `playsinline`；從背景切回來自動恢復相機畫面 |
| App 內建瀏覽器 | LINE 會自動改用手機瀏覽器開；Instagram／Facebook 顯示「請用 Safari／Chrome 開啟」 |

**新增卡牌**：
1. 把新卡圖和舊卡圖**一起**重新編譯成一個 `targets.mind`（上傳順序＝`targetIndex`）。
2. 在 `app.js` 的 `CARD_CONFIG` 複製一個 `{ … }`，改 `targetIndex`、`speaker`、`lines`、`demo`。

**換正式人物**：.glb 的正面朝 +Z、以任意單位建模都可以（程式會縮放）。示範動畫命名 `PlayDemo`、待機命名 `Idle`，然後在 `CARD_CONFIG` 填 `character.model: './assets/models/xxx.glb'`。

---

## 3. 產生 targets.mind（MindAR 官方線上編譯器）

1. 打開 MindAR 官方 Image Targets Compiler：https://hiukim.github.io/mind-ar-js-doc/tools/compile
2. 把卡面圖拖進去（先用 `assets/test-card_WaterIntake.png` 試）。多張卡就一次全部拖進去，**順序就是 targetIndex**（第一張＝0）。
3. 按 **Start**，等進度跑完（幾十秒）。
4. 按 **Download compiled**，得到 `targets.mind`，放進 `assets/`。

**卡面要好辨識**：圖案細節多、對比高，不要大片純色或重複花紋。只有文字或大面積留白的卡會辨識不到或抖動。編譯器會顯示特徵點，點越多、分布越平均越好。正式卡面設計時，背景可加插畫紋理。

---

## 4. 電腦上測試（VS Code Live Server）

相機只能在 **https** 或 **localhost** 下使用。

1. VS Code 安裝擴充功能 **Live Server**（作者 Ritwick Dey）。
2. 用 VS Code 打開 `yishui-ar` 資料夾，右下角按 **Go Live**，瀏覽器會開 `http://127.0.0.1:5500/`。
3. 按「開啟 AR 輔助掃描」，允許相機。
4. 用**手機螢幕顯示測試卡**對著筆電鏡頭，或拿印出來的卡。
5. 打開瀏覽器開發者工具（F12）看 Console：有紅字就把訊息貼回來。

> 用手機連電腦的區網 IP（例如 `http://192.168.x.x:5500`）**不能開相機**，因為不是 https。手機測試請用第 5 節的 GitHub Pages。
> Android 臨時測試可以在 Chrome 開 `chrome://flags` → 搜尋 **Insecure origins treated as secure** → 填入區網網址 → Enable → 重開 Chrome。iPhone 沒有這個選項。

---

## 5. 上傳 GitHub Pages，用手機實測

1. GitHub 新增一個**公開**儲存庫，例如 `yishui-ar`（和時光水滴的 `yishui-qiantian` 分開，互不影響）。
2. 把整個資料夾內容上傳（保持 `assets/` 結構，包含 `targets.mind`）。
3. Settings → Pages → Source 選 **Deploy from a branch**，Branch 選 `main`、資料夾 `/ (root)` → Save。
4. 約 1～2 分鐘後網址是 `https://<帳號>.github.io/yishui-ar/`，做成 QR Code 給手機掃。

**手機實測注意事項**
- 用 **Safari（iPhone）** 或 **Chrome（Android）** 開。用 LINE 掃 QR 時會自動跳到外部瀏覽器；Instagram、Facebook 要手動選「用瀏覽器開啟」。
- 第一次會問相機權限，按「允許」。按錯了：iPhone 到 設定 › Safari › 相機；Android 點網址列左邊的圖示 › 權限。
- 更新檔案後手機看到的還是舊版：GitHub Pages 有快取，等幾分鐘，或在網址後面加 `?v=2`。
- 卡牌放平在桌上、光線充足、避免反光；手機距離卡牌約 20～40 公分。
- 展場要先測當地的手機網路：第一次開啟需要下載 Three.js 與 MindAR（合計約 1～2 MB）。

### 測試檢查清單
- [ ] 開啟後看到開始畫面，按「開啟 AR 輔助掃描」→ 允許相機 → 出現掃描框與「請將鏡頭對準要查詢的卡牌」。
- [ ] 對準卡牌 1～2 秒內，小人從卡面長出來，掃描框消失。
- [ ] 自動示範一次：抬手、水圳由左長到右、發光點移動、終點閃三下。
- [ ] 對話框顯示「水利技師」與第一句；「下一句」翻頁；最後一句按鈕變「我知道了」。
- [ ] 「收起提示」關掉對話框；「重播示範」重播並重新打開對話框。
- [ ] 手震或手指短暫遮住卡牌：小人停在原地、動作暫停，不閃爍；放開後接著動。
- [ ] 卡牌移出畫面超過 0.5 秒：小人縮小消失，掃描框回來；放回卡牌：小人回來，示範從中斷處繼續。
- [ ] 「重新掃描」：小人消失、回到掃描狀態；再對準會重新出現並從頭示範。
- [ ] 拒絕相機權限時，畫面顯示如何開啟權限。
- [ ] iPhone Safari、Android Chrome 各測一支。

---

## 6. 已知限制
- 程式只做過語法檢查，**還沒在實機或瀏覽器裡跑過**；第一次測試若 Console 有紅字，把訊息貼回來修。
- 範例台詞與「取水口必須先接主幹渠」是示意，正式規則與人物名稱要等桌遊規則定案、組內確認。
- 同一時間只顯示一位人物：兩張卡同時入鏡時，維持先出現的那位。
