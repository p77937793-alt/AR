/* ═══════════════════════════════════════════════════════════════
   一水千田｜卡牌 AR 輔助提示（MVP）
   流程：開啟相機 → 掃一張卡 → 歷史人物出現 → 示範一個容易搞錯的操作

   檔案分區
   1. 設定（AR 參數、卡牌台詞與示範）        ← 新增卡牌只改這裡
   2. 小工具
   3. 人物：佔位幾何人物＋外部 .glb 載入
   4. ARCardManager：追蹤、緩衝、平滑跟隨、淡入淡出
   5. ARUI：開始畫面、掃描引導、對話框、按鈕
   6. 啟動：環境檢查、相機權限、MindAR
   ═══════════════════════════════════════════════════════════════ */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MindARThree } from 'mindar-image-three';

/* ═══════════════════════════════════════════════════════════════
   1. 設定
   ═══════════════════════════════════════════════════════════════ */

/** AR 全域參數 */
const AR_SETTINGS = {
  // 卡牌特徵檔：用 MindAR 官方編譯器產生（多張卡就一起編譯成同一個檔案）
  targetSrc: './assets/targets.mind',

  // 失去追蹤後的緩衝時間（毫秒）：這段時間內重新偵測到就不中斷，人物停在原地、動畫暫停
  lostGraceMs: 500,
  // 人物出現／消失的縮放時間（毫秒）
  fadeMs: 250,
  // 人物跟隨卡牌的速度：越大越跟手，越小越平滑（用來吸收手震）
  followSharpness: 14,
  // 人物轉身面向鏡頭（只沿卡面法線旋轉）
  faceCamera: true,
  // 按「重新掃描」後暫停偵測的時間（毫秒），避免舊的追蹤結果立刻又跳出人物
  resetCooldownMs: 500,

  // MindAR 內建的追蹤濾波（One Euro Filter）。人物抖動：調小 filterMinCF / filterBeta；
  // 反應太慢：調大。warmup / miss 是「連續幾幀才算找到／遺失」。
  mindar: {
    filterMinCF: 0.001,
    filterBeta: 1000,
    warmupTolerance: 5,
    missTolerance: 5,
  },
};

/**
 * 卡牌設定：一張卡一個物件。
 *
 * 座標說明（demo.from / demo.to）：
 *   以卡牌寬度＝1 為單位，原點是卡牌中心（人物腳下）。
 *   [x, z]：x 正＝畫面右邊，z 正＝靠近鏡頭的一側。卡牌高度約 1.4（63×88 mm）。
 */
const CARD_CONFIG = [
  {
    targetIndex: 0,                 // 對應 targets.mind 裡的第幾張圖（從 0 開始，依編譯時上傳的順序）
    id: 'Card_WaterIntake',
    speaker: '水利技師',            // 名稱標籤（正式人物待組內確認）
    portrait: null,                 // 頭像圖片路徑，例如 './assets/portraits/engineer.png'；null＝不顯示
    lines: [                        // 每句 1～2 行白話；規則定案前為示意文字
      '注意！修建取水口時，必須先連接主幹渠，不能直接蓋在旱地上喔！',
      '水要一段一段接過去：取水口 → 主幹渠 → 支線，中間斷掉就送不到田裡。',
    ],
    character: {
      model: null,                  // 正式 .glb 路徑，例如 './assets/models/engineer.glb'；null＝佔位人物
      height: 0.9,                  // 人物高度（卡牌寬度＝1）
      heightOffset: 0.01,           // 腳底離卡面的高度
      demoClip: 'PlayDemo',         // .glb 裡示範動畫的名稱
      idleClip: 'Idle',             // .glb 裡待機動畫的名稱（沒有也可以）
      yawOffsetDeg: 0,              // 模型正面不是朝 +Z 時，用這個轉正
    },
    demo: {                         // 佔位人物的示範：水圳從起點「長」到終點，發光點沿線移動，終點閃爍
      from: [-0.38, 0.4],           // 起點（取水口）
      to: [0.38, 0.4],              // 終點（主幹渠接上的位置）
      duration: 2.4,                // 秒
      color: '#ffd34d',
    },
  },
  // 新增卡牌：複製上面整個 { … }，改 targetIndex、台詞與示範設定即可
];

/* ═══════════════════════════════════════════════════════════════
   2. 小工具
   ═══════════════════════════════════════════════════════════════ */

const $ = (id) => document.getElementById(id);
const clamp01 = (x) => Math.min(Math.max(x, 0), 1);
const smooth = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function disposeObject(root) {
  root.traverse((o) => {
    o.geometry?.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    mats.forEach((m) => m.dispose());
  });
}

function makeShadow(radius = 0.22) {
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 32),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.002;
  return m;
}

/* ═══════════════════════════════════════════════════════════════
   3. 人物
   兩種人物對外介面相同：
   { root, isPlaying, playDemo(), stopDemo(), pause(), resume(), update(dt), dispose() }
   人物的本地座標：+Y 朝上、+Z 面向鏡頭、腳底在原點（manager 會負責立到卡牌上）
   ═══════════════════════════════════════════════════════════════ */

/** 佔位人物：幾何體組成的戴斗笠小人＋「水圳連接」示範道具 */
function createPlaceholderCharacter(card) {
  const cfg = card.character ?? {};
  const demoCfg = card.demo ?? {};
  const mat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.7 });

  const root = new THREE.Group();
  root.add(makeShadow());

  // ── 人物（以高度約 1 建模，再縮放成設定高度） ──
  const figure = new THREE.Group();
  figure.scale.setScalar((cfg.height ?? 0.9) / 1.01);
  root.add(figure);

  const body = new THREE.Group();          // 示範時會跳動的部分
  figure.add(body);

  const robe = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.4, 4, 16), mat(0x2f5d8a));
  robe.position.y = 0.35;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 24, 16), mat(0xf1c9a0));
  head.position.y = 0.82;
  const hat = new THREE.Mesh(new THREE.ConeGeometry(0.27, 0.12, 32), mat(0xc9a24b));   // 斗笠
  hat.position.y = 0.95;
  body.add(robe, head, hat);

  const eyeGeo = new THREE.SphereGeometry(0.018, 8, 8);
  const eyeMat = mat(0x1a1a1a);
  for (const x of [-0.045, 0.045]) {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(x, 0.84, 0.12);       // +Z＝臉朝鏡頭
    body.add(eye);
  }

  // 手臂：轉軸在肩膀，示範時抬起指向水圳（在畫面右側）
  const shoulder = new THREE.Group();
  shoulder.position.set(0.17, 0.58, 0);
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.3, 12), mat(0x2f5d8a));
  arm.position.y = -0.15;
  const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), mat(0xf1c9a0));
  hand.position.y = -0.31;
  shoulder.add(arm, hand);
  body.add(shoulder);

  // ── 示範道具（不跟著人物縮放，座標以卡牌寬度＝1 計） ──
  const color = new THREE.Color(demoCfg.color ?? '#ffd34d');
  const from = new THREE.Vector3(demoCfg.from?.[0] ?? -0.38, 0, demoCfg.from?.[1] ?? 0.4);
  const to = new THREE.Vector3(demoCfg.to?.[0] ?? 0.38, 0, demoCfg.to?.[1] ?? 0.4);
  const dir = to.clone().sub(from);
  const len = dir.length();

  const props = new THREE.Group();
  props.visible = false;
  root.add(props);

  const source = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.04, 24), mat(0x3b8fd0));   // 取水口
  source.position.set(from.x, 0.02, from.z);

  const channel = new THREE.Mesh(                         // 水圳：沿 x 軸的細長方塊，旋轉到起點→終點方向
    new THREE.BoxGeometry(1, 0.012, 0.04),
    new THREE.MeshBasicMaterial({ color: 0x5ab4ff }),
  );
  channel.rotation.y = Math.atan2(-dir.z, dir.x);

  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12), new THREE.MeshBasicMaterial({ color }));

  const ring = new THREE.Mesh(                            // 終點圈
    new THREE.RingGeometry(0.05, 0.075, 32),
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(to.x, 0.006, to.z);
  props.add(source, channel, glow, ring);

  // 水圳長度 0～1
  function setChannel(p) {
    channel.scale.x = Math.max(len * p, 0.0001);
    channel.position.copy(from).addScaledVector(dir, p / 2);
    channel.position.y = 0.008;
  }

  // ── 示範時間軸 ──
  const LEAD = 0.3;                         // 等人物長出來
  const DURATION = demoCfg.duration ?? 2.4; // 水圳延伸
  const BLINK = 1.2;                        // 終點閃三下（每秒 2.5 次，不刺眼）
  let demoT = -1;                           // -1＝沒有在示範
  let idleT = 0;
  let paused = false;

  function resetPose() {
    body.position.y = 0;
    shoulder.rotation.set(0, 0, 0);
    glow.scale.setScalar(1);
  }

  return {
    root,
    get isPlaying() { return demoT >= 0; },

    playDemo() {
      paused = false;
      demoT = 0;
      resetPose();
      props.visible = true;
      setChannel(0);
      glow.position.set(from.x, 0.035, from.z);
      ring.visible = false;
    },

    stopDemo() {
      demoT = -1;
      resetPose();
      props.visible = false;
    },

    pause() { paused = true; },
    resume() { paused = false; },

    update(dt) {
      if (paused) return;                 // 暫停：所有動作停在原處
      idleT += dt;

      if (demoT < 0) {                    // 待機：輕微呼吸
        body.position.y = Math.sin(idleT * 2.2) * 0.004;
        return;
      }

      demoT += dt;
      const t = demoT - LEAD;
      if (t < 0) return;

      // 手臂抬起指向水圳
      const raise = smooth(t / 0.4);
      shoulder.rotation.z = 1.25 * raise;
      shoulder.rotation.x = -0.55 * raise;

      if (t <= DURATION) {
        // 水圳從取水口長出去，發光點沿線移動，人物跳兩下
        const p = t / DURATION;
        body.position.y = Math.abs(Math.sin(p * Math.PI * 2)) * 0.06;
        setChannel(smooth(p));
        glow.position.lerpVectors(from, to, smooth(p));
        glow.position.y = 0.035;
        glow.scale.setScalar(1 + 0.3 * Math.sin(t * 12));
      } else if (t <= DURATION + BLINK) {
        // 終點閃三下：「接到這裡才算完成」
        body.position.y = 0;
        setChannel(1);
        glow.position.set(to.x, 0.035, to.z);
        glow.scale.setScalar(1);
        ring.visible = Math.floor((t - DURATION) / 0.2) % 2 === 1;
      } else {
        // 結束：保留水圳與終點圈當提示，手放下
        ring.visible = true;
        shoulder.rotation.set(0, 0, 0);
        demoT = -1;
      }
    },

    dispose() { disposeObject(root); },
  };
}

/**
 * 載入外部 .glb 人物（標準替換函式）
 * - 自動縮放成設定高度、腳底對齊卡面、水平置中
 * - 有名為 demoClip 的動畫就當示範（播一次）；有 idleClip 就循環待機
 * - 找不到 demoClip 時，改用第一個不是待機的動畫
 */
const gltfLoader = new GLTFLoader();

async function loadGLBCharacter(url, options = {}) {
  const { height = 0.9, demoClip = 'PlayDemo', idleClip = 'Idle', yawOffsetDeg = 0 } = options;
  const gltf = await gltfLoader.loadAsync(url);
  const model = gltf.scene;

  // 自動縮放與對齊
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  if (size.y > 0) model.scale.multiplyScalar(height / size.y);
  box.setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= box.min.y;

  const facing = new THREE.Group();
  facing.rotation.y = THREE.MathUtils.degToRad(yawOffsetDeg);
  facing.add(model);

  const root = new THREE.Group();
  root.add(makeShadow(height * 0.25), facing);

  // 動畫
  const mixer = new THREE.AnimationMixer(model);
  const clips = gltf.animations ?? [];
  const idle = THREE.AnimationClip.findByName(clips, idleClip);
  const demo = THREE.AnimationClip.findByName(clips, demoClip) ?? clips.find((c) => c !== idle) ?? null;
  const idleAction = idle ? mixer.clipAction(idle) : null;
  const demoAction = demo ? mixer.clipAction(demo) : null;

  if (demoAction) {
    demoAction.setLoop(THREE.LoopOnce, 1);
    demoAction.clampWhenFinished = true;
  } else {
    console.warn(`[AR] ${url} 沒有動畫，示範時人物不會動。`);
  }
  idleAction?.play();

  let playing = false;
  mixer.addEventListener('finished', (e) => {
    if (e.action !== demoAction) return;
    playing = false;
    if (idleAction) {
      demoAction.fadeOut(0.3);
      idleAction.reset().fadeIn(0.3).play();
    }
  });

  return {
    root,
    get isPlaying() { return playing; },
    playDemo() {
      if (!demoAction) return;
      mixer.timeScale = 1;
      playing = true;
      idleAction?.fadeOut(0.2);
      demoAction.reset().fadeIn(0.2).play();
    },
    stopDemo() {
      playing = false;
      demoAction?.stop();
      idleAction?.reset().play();
    },
    pause() { mixer.timeScale = 0; },
    resume() { mixer.timeScale = 1; },
    update(dt) { mixer.update(dt); },
    dispose() { mixer.stopAllAction(); disposeObject(root); },
  };
}

/** 依卡牌設定建立人物：有 .glb 就載入，失敗或沒設定就用佔位人物 */
async function createCharacter(card) {
  const url = card.character?.model;
  if (url) {
    try {
      return await loadGLBCharacter(url, card.character);
    } catch (err) {
      console.warn(`[AR] 載入 ${url} 失敗，改用佔位人物。`, err);
    }
  }
  return createPlaceholderCharacter(card);
}

/* ═══════════════════════════════════════════════════════════════
   4. ARCardManager
   - 人物不直接掛在 MindAR 的 anchor 下，而是放在自己的 follower 群組，
     每幀平滑追上卡牌位置：可吸收手震，失去追蹤時也能停在最後位置不閃爍。
   - 失去追蹤 → 立刻暫停動畫；500ms 內找回 → 繼續；超過 → 縮小消失。
   - 同一時間只顯示一位人物，避免兩張卡同時入鏡時跳來跳去。
   事件：'cardshown'、'cardhidden'、'reset'
   ═══════════════════════════════════════════════════════════════ */

const _cam = new THREE.Vector3();

class ARCardManager extends EventTarget {
  constructor({ mindarThree, cards, settings }) {
    super();
    this.mindar = mindarThree;
    this.scene = mindarThree.scene;
    this.camera = mindarThree.camera;
    this.opt = settings;
    this.active = null;
    this.ignoreUntil = 0;
    this.states = cards.map((card) => this._setupCard(card));
  }

  _setupCard(card) {
    const anchor = this.mindar.addAnchor(card.targetIndex);

    // follower：卡面座標（MindAR：卡牌寬＝1、卡面在 XY 平面、+Z 朝外）
    const follower = new THREE.Group();
    follower.visible = false;
    this.scene.add(follower);

    // content：淡入淡出用的縮放
    const content = new THREE.Group();
    content.position.z = card.character?.heightOffset ?? 0.01;
    content.scale.setScalar(0.0001);
    follower.add(content);

    // yawPivot：沿卡面法線轉，讓人物面向鏡頭
    const yawPivot = new THREE.Group();
    content.add(yawPivot);

    // upright：把人物的 +Y（上）轉成卡面的 +Z（朝外），人物就站在卡上
    const upright = new THREE.Group();
    upright.rotation.x = Math.PI / 2;
    yawPivot.add(upright);

    const state = {
      card, anchor, follower, content, yawPivot, upright,
      character: null,
      loading: false,
      tracking: false,
      lastSeen: -Infinity,
      paused: false,
      hasPlayedDemo: false,
      fade: 0,
      fadeTarget: 0,
      yaw: 0,
      targetPos: new THREE.Vector3(),
      targetQuat: new THREE.Quaternion(),
      targetScale: new THREE.Vector3(1, 1, 1),
    };

    anchor.onTargetFound = () => { state.tracking = true; };
    anchor.onTargetLost = () => { state.tracking = false; };
    return state;
  }

  /** 先把所有人物載好，第一次掃到時就不用等 */
  preloadAll() {
    this.states.forEach((s) => this._ensureCharacter(s));
  }

  _ensureCharacter(s) {
    if (s.character || s.loading) return;
    s.loading = true;
    createCharacter(s.card)
      .then((character) => {
        s.character = character;
        s.upright.add(character.root);
      })
      .catch((err) => console.error('[AR] 人物建立失敗', err))
      .finally(() => { s.loading = false; });
  }

  /** 每幀呼叫 */
  update(dt) {
    const now = performance.now();
    const canDetect = now >= this.ignoreUntil;

    // 1. 收集這一幀正在追蹤的卡
    const seen = [];
    for (const s of this.states) {
      if (!s.tracking || !canDetect) continue;
      s.anchor.group.matrix.decompose(s.targetPos, s.targetQuat, s.targetScale);
      s.lastSeen = now;
      this._ensureCharacter(s);
      seen.push(s);
    }

    // 2. 顯示中的卡：失去追蹤就暫停，超過緩衝時間就隱藏
    const a = this.active;
    if (a) {
      if (a.lastSeen === now) {
        if (a.paused) { a.paused = false; a.character?.resume(); }   // 找回：平順恢復
      } else {
        if (!a.paused) { a.paused = true; a.character?.pause(); }    // 暫時遺失：停在原地
        if (now - a.lastSeen > this.opt.lostGraceMs) {
          this._hide(a);
          this.active = null;
        }
      }
    }

    // 3. 沒有顯示中的人物 → 挑一張這一幀看到、而且人物已載好的卡
    if (!this.active) {
      const next = seen.find((s) => s.character);
      if (next) {
        this.active = next;
        this._show(next);
      }
    }

    // 4. 跟隨、淡入淡出、人物動畫
    const k = 1 - Math.exp(-this.opt.followSharpness * dt);
    for (const s of this.states) {
      if (s === this.active) this._follow(s, k);
      this._stepFade(s, dt);
      if (s.character && s.follower.visible) s.character.update(dt);
    }
  }

  /** 播放（或重播）目前人物的示範 */
  playDemo() {
    const s = this.active;
    if (!s?.character) return false;
    s.paused = false;
    s.character.resume();
    s.character.playDemo();
    s.hasPlayedDemo = true;
    return true;
  }

  /** 重新掃描：隱藏所有人物、清除狀態，短暫停止偵測 */
  reset() {
    for (const s of this.states) {
      s.fade = 0;
      s.fadeTarget = 0;
      s.content.scale.setScalar(0.0001);
      s.follower.visible = false;
      s.paused = false;
      s.hasPlayedDemo = false;
      s.lastSeen = -Infinity;
      s.character?.stopDemo();
      s.character?.resume();
    }
    this.active = null;
    this.ignoreUntil = performance.now() + this.opt.resetCooldownMs;
    this.dispatchEvent(new CustomEvent('reset'));
  }

  _show(s) {
    // 第一次出現直接放到定位，不從畫面外滑進來
    s.follower.position.copy(s.targetPos);
    s.follower.quaternion.copy(s.targetQuat);
    s.follower.scale.copy(s.targetScale);
    const yaw = this._desiredYaw(s);
    if (yaw !== null) s.yaw = yaw;
    s.yawPivot.rotation.z = s.yaw;

    s.fadeTarget = 1;
    s.follower.visible = true;
    if (s.paused) { s.paused = false; s.character.resume(); }   // 上次示範到一半 → 接著播
    this.dispatchEvent(new CustomEvent('cardshown', { detail: { card: s.card, state: s } }));
  }

  _hide(s) {
    s.fadeTarget = 0;   // 動畫維持暫停，下次找回再繼續
    this.dispatchEvent(new CustomEvent('cardhidden', { detail: { card: s.card } }));
  }

  _follow(s, k) {
    s.follower.position.lerp(s.targetPos, k);
    s.follower.quaternion.slerp(s.targetQuat, k);
    s.follower.scale.lerp(s.targetScale, k);

    const yaw = this._desiredYaw(s);
    if (yaw !== null) {
      s.yaw = wrapAngle(s.yaw + wrapAngle(yaw - s.yaw) * k);
      s.yawPivot.rotation.z = s.yaw;
    }
  }

  /** 計算讓人物面向鏡頭的旋轉角；鏡頭幾乎正上方俯視時回傳 null（維持原方向） */
  _desiredYaw(s) {
    if (!this.opt.faceCamera) return null;
    s.follower.updateMatrixWorld(true);
    this.camera.getWorldPosition(_cam);
    s.follower.worldToLocal(_cam);
    if (Math.hypot(_cam.x, _cam.y) < Math.abs(_cam.z) * 0.15) return null;
    // 人物正面（+Z）經 upright 轉成卡面的 -Y；轉 θ 後正面 = (sinθ, -cosθ)
    return Math.atan2(_cam.x, -_cam.y);
  }

  _stepFade(s, dt) {
    if (s.fade === s.fadeTarget) return;
    const step = (dt * 1000) / this.opt.fadeMs;
    s.fade = s.fadeTarget > s.fade
      ? Math.min(s.fadeTarget, s.fade + step)
      : Math.max(s.fadeTarget, s.fade - step);
    s.content.scale.setScalar(Math.max(smooth(s.fade), 0.0001));
    if (s.fade === 0) s.follower.visible = false;
  }
}

/* ═══════════════════════════════════════════════════════════════
   5. ARUI：畫面上的 2D 介面
   ═══════════════════════════════════════════════════════════════ */

class ARUI {
  constructor() {
    this.el = {
      start: $('start-screen'), startBtn: $('btn-start'), inApp: $('inapp-hint'),
      loading: $('loading'), error: $('error-screen'), errorMsg: $('error-msg'), retry: $('btn-retry'),
      scanGuide: $('scan-guide'), reset: $('btn-reset'), replay: $('btn-replay'),
      dialogue: $('dialogue'), portrait: $('dlg-portrait'), name: $('dlg-name'), line: $('dlg-line'),
      next: $('dlg-next'), close: $('dlg-close'),
    };
    this.labels = { next: '下一句', last: '我知道了', empty: '（這張卡還沒有設定提示）' };

    this.manager = null;
    this.current = null;      // 目前顯示的卡
    this.lastShown = null;    // 上一張出現過的卡（判斷是不是同一張卡回來）
    this.lineIndex = 0;
    this.closedByUser = false;

    this.el.next.addEventListener('click', () => this._next());
    this.el.close.addEventListener('click', () => this._collapse());
    this.el.retry.addEventListener('click', () => location.reload());
  }

  /** 綁定「開啟 AR 輔助掃描」按鈕 */
  onStart(handler) {
    this.el.startBtn.addEventListener('click', async () => {
      this.el.startBtn.disabled = true;
      this.el.start.hidden = true;
      this.el.loading.hidden = false;
      try {
        await handler();
        this.el.loading.hidden = true;
        this.el.reset.hidden = false;
        this._showScanning();
      } catch (err) {
        console.error(err);
        this.el.loading.hidden = true;
        this.showError(err?.message || '發生未知錯誤，請重新整理再試一次。');
      }
    });
  }

  /** 接上 ARCardManager 的事件 */
  bind(manager) {
    this.manager = manager;
    manager.addEventListener('cardshown', (e) => this._onShown(e.detail));
    manager.addEventListener('cardhidden', (e) => this._onHidden(e.detail));
    manager.addEventListener('reset', () => this._onReset());
    this.el.replay.addEventListener('click', () => this._replay());
    this.el.reset.addEventListener('click', () => manager.reset());
  }

  showError(message) {
    this.el.errorMsg.textContent = message;
    this.el.error.hidden = false;
  }

  showInAppHint(message) {
    this.el.inApp.textContent = message;
    this.el.inApp.hidden = false;
  }

  // ── 事件處理 ──

  _onShown({ card, state }) {
    const isNewCard = card !== this.lastShown;
    this.current = card;
    this.lastShown = card;

    this.el.scanGuide.hidden = true;
    this.el.replay.hidden = false;

    // 換一張卡：從第一句開始；同一張卡回來：接著上次的句子
    if (isNewCard) {
      this.lineIndex = 0;
      this.closedByUser = false;
    }
    if (!this.closedByUser) this._openDialogue();

    // 第一次出現自動示範；之後要看就按「重播示範」
    if (!state.hasPlayedDemo) this.manager.playDemo();
  }

  _onHidden({ card }) {
    if (card !== this.current) return;
    this.current = null;
    this._showScanning();
  }

  _onReset() {
    this.current = null;
    this.lastShown = null;
    this._showScanning();
  }

  // ── 按鈕 ──

  _next() {
    if (!this.current) return;
    const count = this.current.lines?.length ?? 0;
    if (this.lineIndex >= count - 1) {
      this._collapse();
      return;
    }
    this.lineIndex += 1;
    this._refreshLine();
  }

  _collapse() {
    this.closedByUser = true;
    this.el.dialogue.hidden = true;
  }

  _replay() {
    if (!this.current) return;
    this.manager.playDemo();
    this.lineIndex = 0;
    this.closedByUser = false;
    this._openDialogue();
  }

  // ── 畫面 ──

  _openDialogue() {
    const card = this.current;
    if (!card) return;
    this.el.name.textContent = card.speaker ?? '';
    if (card.portrait) {
      this.el.portrait.src = card.portrait;
      this.el.portrait.hidden = false;
    } else {
      this.el.portrait.hidden = true;
    }
    this._refreshLine();
    this.el.dialogue.hidden = false;
  }

  _refreshLine() {
    const lines = this.current?.lines ?? [];
    const count = lines.length;
    this.el.line.textContent = count === 0 ? this.labels.empty : lines[Math.min(this.lineIndex, count - 1)];
    this.el.next.textContent = this.lineIndex >= count - 1 ? this.labels.last : this.labels.next;
  }

  _showScanning() {
    this.el.dialogue.hidden = true;
    this.el.replay.hidden = true;
    this.el.scanGuide.hidden = false;
  }
}

/* ═══════════════════════════════════════════════════════════════
   6. 啟動
   ═══════════════════════════════════════════════════════════════ */

const ui = new ARUI();
handleInAppBrowser();
ui.onStart(startAR);

/** LINE、Instagram、Facebook 的內建瀏覽器常常不能開相機 */
function handleInAppBrowser() {
  const ua = navigator.userAgent;
  if (/\bLine\//i.test(ua)) {
    // LINE：網址加上 openExternalBrowser=1，會自動改用手機預設瀏覽器開啟
    const url = new URL(location.href);
    if (!url.searchParams.has('openExternalBrowser')) {
      url.searchParams.set('openExternalBrowser', '1');
      location.replace(url.toString());
      return;
    }
  }
  if (/Instagram|FBAN|FBAV|Line\//i.test(ua)) {
    ui.showInAppHint('你正在 App 內建的瀏覽器裡，可能無法開啟相機。請點右上角「⋯」→ 用 Safari／Chrome 開啟。');
  }
}

/** 正式啟動前的檢查：先自己要相機權限，失敗時才能顯示清楚的原因 */
async function preflight() {
  if (!window.isSecureContext) {
    throw new Error('相機只能在 https 網址使用。請用 GitHub Pages 的 https 網址開啟；電腦測試請用 http://localhost。');
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('這個瀏覽器不支援相機。請改用 Safari（iPhone）或 Chrome（Android）開啟。');
  }

  const res = await fetch(AR_SETTINGS.targetSrc, { method: 'HEAD', cache: 'no-store' }).catch(() => null);
  if (!res || !res.ok) {
    throw new Error(`找不到卡牌特徵檔 ${AR_SETTINGS.targetSrc}。請確認 targets.mind 已放進 assets 資料夾。`);
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (err) {
    throw new Error(cameraErrorMessage(err));
  }
  stream.getTracks().forEach((t) => t.stop());   // 只是確認權限，馬上關掉，交給 MindAR 開
}

function cameraErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '沒有相機權限。iPhone：設定 › Safari › 相機 → 允許；Android：點網址列左邊的圖示 › 權限 › 相機 → 允許。改完後重新整理。';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '找不到可以使用的相機。';
    case 'NotReadableError':
    case 'AbortError':
      return '相機正被其他 App 使用，請關閉其他使用相機的 App 後再試。';
    default:
      return `相機無法啟動（${err?.name || '未知錯誤'}）。`;
  }
}

/** 解鎖音效（之後要加人物語音時用；必須在使用者點擊時執行） */
let audioContext = null;
function unlockAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioContext ??= new Ctx();
    audioContext.resume?.();
  } catch { /* 沒有音效也不影響 AR */ }
}

/** iOS 需要 video 帶 playsinline，不然會跳成全螢幕播放 */
function forceInlineVideo(container) {
  container.querySelectorAll('video').forEach((v) => {
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.muted = true;
  });
}

async function startAR() {
  unlockAudio();
  await preflight();

  const container = $('ar-container');
  const mindarThree = new MindARThree({
    container,
    imageTargetSrc: AR_SETTINGS.targetSrc,
    maxTrack: 1,            // 一次只追一張卡
    uiLoading: 'no',        // 關掉 MindAR 內建介面，改用我們自己的
    uiScanning: 'no',
    uiError: 'no',
    ...AR_SETTINGS.mindar,
  });
  const { renderer, scene, camera } = mindarThree;

  // 燈光
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.8));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(0.3, 1, 0.6);
  scene.add(sun);

  const manager = new ARCardManager({ mindarThree, cards: CARD_CONFIG, settings: AR_SETTINGS });
  ui.bind(manager);
  manager.preloadAll();

  try {
    await mindarThree.start();
  } catch (err) {
    throw new Error('AR 啟動失敗。請確認相機權限，或換用 Safari／Chrome 再試一次。');
  }
  forceInlineVideo(container);

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);   // 切回分頁時避免一次跳很多
    manager.update(dt);
    renderer.render(scene, camera);
  });

  // 從背景切回來時，iOS 可能把相機畫面暫停，重新播放
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    container.querySelectorAll('video').forEach((v) => v.play?.().catch(() => {}));
    clock.getDelta();
  });
}
