/*
 * scout.js - スカウト抽選ロジック
 *
 * 役割分担（企画のフィードバック反映）:
 *  - スカウト施設レベル：排出されうるレアリティの「上限」を決める
 *  - 監督施設レベル：抽選候補の中で「よりレアなもの」「未所持のもの」が選ばれる確率を上げる
 *  - 成績（placement）：抽選クオリティ（平均レアリティ）と抽選回数に反映
 *  - 限定キャラ（exclusivePlayerIds）は優勝時に保証枠
 *  - 被り（重複）は自動的に資金に変換
 *  - 返り値の「pulls」は、低レア→高レアの順で最後に大物が出るよう並べて返す
 *
 * ブラウザ・Nodeどちらでも動く（依存なし）。数値は TUNING をいじるだけで調整。
 */

const TUNING = {
  // 成績スコア（0-1）。良い成績ほど狙う平均レアリティが引き上がる
  placementScore: { champion: 1.0, runnerUp: 0.7, semifinal: 0.5, participated: 0.3 },
  // 成績ごとの抽選回数
  numDraws: { champion: 5, runnerUp: 3, semifinal: 2, participated: 1 },
  // 平均レアリティの決定：成績とスカウトレベルの加重和（合計1）
  qualityWeights: { placement: 0.6, facility: 0.4 },
  maxFacilityLevel: 10,
  // 抽選レアリティ周りの散らばり（大きいほどバラツク）
  raritySpread: 2.5,
  // この成績のとき、限定キャラを1枠保証（未所持優先）
  exclusiveGuaranteeOn: ['champion'],
  // 被り時の資金換算（レアリティ比例）
  dupeRefund: (rarity) => rarity * 100,
  // 星の色帯（演出との共通定義）
  rarityBands: [[1, 9], [10, 14], [15, 16], [17, 18], [19, 20]],
};

// ---- ユーティリティ -------------------------------------------------------
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function randInt(n) { return Math.floor(Math.random() * n); }

// 標準正規乱数（Box-Muller）
function gaussian(mean, std) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + z * std;
}

// レアリティ→色帯インデックス（0..bands-1）
function bandOf(rarity, bands = TUNING.rarityBands) {
  for (let i = 0; i < bands.length; i++) {
    if (rarity >= bands[i][0] && rarity <= bands[i][1]) return i;
  }
  return bands.length - 1;
}

// ---- コア ---------------------------------------------------------------

// 候補プール構築（カップの候補フィルタで絞る。限定キャラは別扱い）
function buildPool(competition, players) {
  const f = competition.candidatePoolFilter || {};
  return players.filter((p) => {
    if (p.exclusiveTo) return false; // 限定キャラは保証枠でのみ登場
    if (p.dexHidden) return false; // 図鑑・スカウト対象外の選手（イングランド4部・5部の架空選手など）
    if (f.minRarity != null && p.rarity < f.minRarity) return false;
    if (f.maxRarity != null && p.rarity > f.maxRarity) return false;
    if (f.categories && !f.categories.includes(p.category)) return false;
    if (f.nationalities && !f.nationalities.includes(p.nationality)) return false;
    return true;
  });
}

// 抽選の質（0-1）＝成績×スカウトレベルの加重
function computeQuality(placement, scoutLevel) {
  const ps = TUNING.placementScore[placement] ?? 0.3;
  const fs = clamp(scoutLevel / TUNING.maxFacilityLevel, 0, 1);
  const w = TUNING.qualityWeights;
  return clamp(w.placement * ps + w.facility * fs, 0, 1);
}

// スカウトレベル→排出されうるレアリティの上限（Lv.1でも★3までは出るようにし、Lv.2以降は従来通りLv.×2、Lv.10で★20）
function maxRarityForScoutLevel(scoutLevel) {
  return clamp(Math.max(3, Math.round(scoutLevel * 2)), 1, 20);
}

// ---- 収集ペースのガードレール ---------------------------------------------
// 「少しずつ良い選手が集まる」体験を守るための共通ルール。
// 資金や運で序盤から★20が獲れてしまう抜け道を塞ぎ、逆に被り続きで収集が
// 止まる事態も防ぐ。数値の意図と適用マップは 収集ペース_ガードレール_v1.md 参照。
const GUARDRAILS = {
  // G1 キャリア天井：クラブのキャリア進行度（単調増加。降格しても下がらない）が
  // 排出レアリティの絶対上限を決める。チケット類もこれを越えられない
  ceilingBase: 8,               // 初期状態（日本・最下部リーグ）の絶対上限
  ceilingPerPromotion: 2,       // 昇格1回ごとに +2
  ceilingPerCountryCleared: 2,  // 国制覇（その国の1部優勝）1回ごとに +2
  cupTitlesPerCeilingStep: 3,   // カップ優勝この回数ごとに +1
  // G2 ステップアップ上限：所持している最高レアリティ + margin までしか新規排出しない
  stepUpMargin: 1,
  // G2拡張：★N（キーの値）を新規に出すには、★(N-1)以上を所持している必要人数。
  // 1人引いただけで連鎖的に上へ跳ねないようにする（★12以下は対象外）
  stepUpOwnedRequired: { 13: 3, 14: 3, 15: 4, 16: 4, 17: 4 },
  // G6 カップ強度上限：通常カップ（レジェンドカップ・ターゲットカップ以外）の排出上限。
  // 参加クラブの戦力（上位cupPowerTopN クラブの平均）を levelTiers に通した★帯が、そのカップの上限になる
  cupPowerTopN: 3,
  // クラブ戦力（先発平均）は個々の看板選手より低く出るため、levelTiers に通す前にこの値を足す
  // （計測：0だと自リーグのカップでは出られない選手が577人、+10で30人まで減る）
  cupPowerOffset: 10,
  normalCupMaxRarity: 17,
  // G7 高レア希少化：通常カップでは該当レアの抽選重みをこの倍率に減衰（強いカップでも「ほんの少し」だけ出る）。
  // ★18以上はレジェンドカップ専用（index.html の LEGEND_ONLY_MIN_RARITY）
  softRarityWeights: { 15: 0.15, 16: 0.07, 17: 0.03 },
  // G3 大物制限：実効上限に近いレア帯（上限 - topBandWidth + 1 以上）は
  // 1回のスカウトで topBandPerScout 人まで
  topBandWidth: 2,
  topBandPerScout: 1,
  // G3拡張：大物枠が抽選対象になるのは1スカウト中の最初のこの回数目まで。
  // 1スカウトの人数が増えても大物の出現確率が比例して底上げされないようにするための上限
  topBandEligibleDraws: 4,
  // G4 停滞救済：新規ゼロ（全被り）のスカウトがこの回数連続したら、
  // 次のスカウトでキャップ内の未所持選手を1人保証する
  pityThreshold: 3,
  // G3の発動条件：実効上限（cap）がこの値未満のときはG3（大物1人まで制限）を無効化する。
  // cap=3のような序盤は「上限-1以上」の帯が★2〜★3と実質ほぼ全域を覆ってしまい、
  // 大物を絞るはずのルールが逆に低レア（★1）への締め出しとして働いてしまうため
  topBandActivationMinCap: 6,
  // G5 低レア抑制：★lowRaritySuppressMax以下の排出重みを、監督レベルが上がるほど
  // 大きく減衰させる（lowRaritySuppressBase / (1 + lowRaritySuppressK * managerLevel)）。
  // 「施設を伸ばすほど★1・★2に会う頻度が目に見えて減る」体験のためのノブ
  lowRaritySuppressMax: 2,
  lowRaritySuppressBase: 0.3,
  lowRaritySuppressK: 1.0,
  // L1 昇格停滞救済（全体ガードレール_v1.md）：昇格可能なディビジョンで昇格できない
  // シーズンがこの回数連続したら、シーズン終了時にスカウト強化チケットを1枚付与する
  promotionDroughtThreshold: 3,
};

// G1: キャリア進行度から排出レアリティの絶対上限を計算する。
// 入力はすべて通算カウンタ（減らない）なので、天井も下がらない
function progressionMaxRarity(progress) {
  const g = GUARDRAILS;
  const p = progress || {};
  const cap = g.ceilingBase
    + (p.promotions || 0) * g.ceilingPerPromotion
    + (p.countriesCleared || 0) * g.ceilingPerCountryCleared
    + Math.floor((p.cupChampionships || 0) / g.cupTitlesPerCeilingStep);
  return clamp(cap, g.ceilingBase, 20);
}

// G2: 所持済みの最高レアリティ + マージン。コレクションが一段ずつ階段状に伸びる
function stepUpMaxRarity(players, collectionState) {
  let maxOwned = 0;
  for (const p of players) {
    if (p.dexHidden) continue;
    const st = collectionState.players[p.id];
    if (st && st.owned && p.rarity > maxOwned) maxOwned = p.rarity;
  }
  let cap = clamp(maxOwned + GUARDRAILS.stepUpMargin, GUARDRAILS.stepUpMargin, 20);
  // ★(N-1)以上の所持数が足りない間は上限を1段ずつ下げる
  const req = GUARDRAILS.stepUpOwnedRequired || {};
  while (cap > 1 && req[cap]) {
    let n = 0;
    for (const p of players) {
      if (p.dexHidden || p.rarity < cap - 1) continue;
      const st = collectionState.players[p.id];
      if (st && st.owned) n++;
    }
    if (n >= req[cap]) break;
    cap--;
  }
  return cap;
}

// G6: 参加クラブの戦力（上位N件の平均）から通常カップの★上限を決める。tiers は data.levelTiers
function cupRarityCap(clubPowers, tiers) {
  const g = GUARDRAILS;
  const top = [...clubPowers].sort((a, b) => b - a).slice(0, g.cupPowerTopN);
  if (top.length === 0) return g.normalCupMaxRarity;
  const power = top.reduce((s, x) => s + x, 0) / top.length + g.cupPowerOffset;
  const tier = (tiers || []).find((t) => power >= t.minOverall);
  return clamp(tier ? tier.maxRarity : 5, 1, g.normalCupMaxRarity);
}

// 実効キャップ一式を返す。
//  hardCap = min(G1天井, G2ステップ上限)…チケット類を含む全入手経路の絶対上限
//  cap     = min(hardCap, 施設上限)   …通常スカウトの上限
function effectiveScoutCaps({ facilityCap, progress, players, collectionState }) {
  const ceiling = progressionMaxRarity(progress);
  const stepCap = stepUpMaxRarity(players, collectionState);
  const hardCap = Math.min(ceiling, stepCap);
  return { ceiling, stepCap, facilityCap, hardCap, cap: Math.min(hardCap, facilityCap) };
}

// 1回分のレアリティを決める：プールのレア幅とスカウト上限の中で、qualityに応じた平均をガウスで散らす
function drawRarity(pool, quality, scoutMaxRarity) {
  const rarities = pool.map((p) => p.rarity);
  const minR = Math.min(...rarities);
  const maxR = Math.max(minR, Math.min(Math.max(...rarities), scoutMaxRarity));
  const mean = lerp(minR, maxR, quality);
  const r = Math.round(clamp(gaussian(mean, TUNING.raritySpread), minR, maxR));
  return r;
}

// 指定レアリティの選手を1人選ぶ（該当レアがなければ最も近いレアから選ぶ）。
// 監督レベルが高いほど「未所持の選手」を優先しやすくなる。
function pickPlayerOfRarity(pool, targetRarity, managerLevel, collectionState) {
  let cands = pool.filter((p) => p.rarity === targetRarity);
  if (cands.length === 0) {
    let best = Infinity, bestR = targetRarity;
    for (const p of pool) {
      const d = Math.abs(p.rarity - targetRarity);
      if (d < best) { best = d; bestR = p.rarity; }
    }
    cands = pool.filter((p) => p.rarity === bestR);
  }

  const unowned = cands.filter((p) => !(collectionState.players[p.id] && collectionState.players[p.id].owned));
  const managerBias = clamp(managerLevel / TUNING.maxFacilityLevel, 0, 1);
  if (unowned.length > 0 && Math.random() < managerBias) {
    cands = unowned;
  }
  return cands[randInt(cands.length)];
}

// 1枠を「所持状態」と突き合わせて解決（新規 or 被り資金化）
function resolvePull(player, collectionState) {
  const st = collectionState.players[player.id];
  const isNew = !(st && st.owned);
  if (isNew) {
    collectionState.players[player.id] = { owned: true, everOwned: true, dupes: 0, level: 1, xp: 0, fatigue: 0 };
    return { player, isNew: true, refund: 0, band: bandOf(player.rarity) };
  } else {
    st.dupes = (st.dupes || 0) + 1;
    const refund = TUNING.dupeRefund(player.rarity);
    return { player, isNew: false, refund, band: bandOf(player.rarity) };
  }
}

/**
 * scout - カップ結果に基づくスカウト抽選
 * @param {string} competitionId
 * @param {"champion"|"runnerUp"|"semifinal"|"participated"} placement
 * @param {number} scoutLevel     スカウト施設レベル（排出レアの上限を決める）
 * @param {number} managerLevel   監督施設レベル（レア・未所持の優先度を上げる）
 * @param {object} data           { players, competitions, ... }（players.sample.json 準拠）
 * @param {object} collectionState { players: { [id]: {owned,dupes,level} } }（破壊的に更新）
 * @returns {{ competition, quality, pulls, totalRefund }}
 */
function scout(competitionId, placement, scoutLevel, managerLevel, data, collectionState) {
  const competition = data.competitions.find((c) => c.id === competitionId);
  if (!competition) throw new Error('competition not found: ' + competitionId);

  const quality = computeQuality(placement, scoutLevel);
  const scoutMaxRarity = maxRarityForScoutLevel(scoutLevel);
  const pool = buildPool(competition, data.players);
  if (pool.length === 0) throw new Error('empty candidate pool for ' + competitionId);

  const pulls = [];

  // 限定キャラ保証枠（優勝時など）：未所持優先
  if (TUNING.exclusiveGuaranteeOn.includes(placement) &&
      Array.isArray(competition.exclusivePlayerIds) &&
      competition.exclusivePlayerIds.length > 0) {
    const exIds = competition.exclusivePlayerIds;
    const unowned = exIds.filter((id) => !(collectionState.players[id] && collectionState.players[id].owned));
    const chosenId = (unowned.length ? unowned : exIds)[randInt((unowned.length ? unowned : exIds).length)];
    const exPlayer = data.players.find((p) => p.id === chosenId);
    if (exPlayer) pulls.push({ ...resolvePull(exPlayer, collectionState), guaranteed: true });
  }

  // 通常枠
  const draws = TUNING.numDraws[placement] ?? 1;
  for (let i = 0; i < draws; i++) {
    const r = drawRarity(pool, quality, scoutMaxRarity);
    const p = pickPlayerOfRarity(pool, r, managerLevel, collectionState);
    pulls.push(resolvePull(p, collectionState));
  }

  // 演出用：低レア→高レアの順（最後に大物が出て盛り上がる）
  pulls.sort((a, b) => a.player.rarity - b.player.rarity);
  const totalRefund = pulls.reduce((s, x) => s + x.refund, 0);

  return { competition: competition.name, quality: Number(quality.toFixed(3)), pulls, totalRefund, scoutMaxRarity };
}

// ブラウザ／Node両対応のエクスポート
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    scout, buildPool, computeQuality, drawRarity, bandOf, maxRarityForScoutLevel, TUNING,
    GUARDRAILS, progressionMaxRarity, stepUpMaxRarity, cupRarityCap, effectiveScoutCaps,
  };
}
