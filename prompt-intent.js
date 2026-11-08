// Kullanıcı mesajlarından ses / e-posta bildirimi tercihlerini çıkaran, kural
// tabanlı küçük bir ayrıştırıcı.
//
// detectPreferences(mesaj) -> { sound, email, persist }
//   sound / email : 'off' (istemiyor) | 'on' (açıkça istiyor) | null (belirtmedi)
//   persist       : { sound, email } -> tercih yalnız bu tur için mi (false),
//                   sohbetin geri kalanı için mi (true)
//
//   "ses ve e-posta gönderme"                    -> off / off   (bu tur)
//   "bitince mail at, ses çalma"                 -> off / on    (bu tur)
//   "sadece ses gönder"                          -> on  / off   (bu tur)
//   "ben söyleyene kadar bildirim gönderme"      -> off / off   (kalıcı)
//   "bu sohbet boyunca sadece e-posta gönder"    -> off / on    (kalıcı)
//   "bildirimleri tekrar aç"                     -> on  / on    (kalıcı)
//   "e-posta gönderme özelliğini düzelt"         -> null / null
//
// decide(mesajlar) bir sohbetteki tüm kullanıcı mesajlarını sırayla işler ve
// SON tur için her kanalın gönderilip gönderilmeyeceğine karar verir.

const CHANNELS = ['sound', 'email'];
const TR_MAP = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };

/** Küçük harfe çevirir, Türkçe karakterleri sadeleştirir, kod bloklarını atar. */
export function normalize(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ') // kod blokları (içlerindeki kelimeler komut değildir)
    .replace(/`[^`\n]*`/g, ' ') // satır içi kod
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .toLocaleLowerCase('tr-TR')
    .replace(/[çğıöşüâîû]/g, (c) => TR_MAP[c])
    .replace(/['’‘´]/g, '') // mail'i -> maili, don't -> dont
    .replace(/(?<=[a-z0-9])-(?=[a-z0-9])/g, '') // e-posta -> eposta, e-mail -> email
    .replace(/\bgeri\s+(donus|bildirim)/g, 'geri$1'); // geri dönüş -> geridonus
}

function tokenize(normalized) {
  return normalized.match(/[a-z0-9]+|[.,!?;:\n]/g) ?? [];
}

// --- Konu kelimeleri -------------------------------------------------------
const GENERIC_TOPIC = /^(?:bildirim|geribildirim|geridonus|notif|uyari)/; // hem ses hem e-posta
const SOUND_TOPIC =
  /^(?:ses|sesi|sesli|sesle|sesler|sesleri|sesini|seslerini|bip|beep|beeps|sound|sounds|alarm|alarmi)$/;
const EMAIL_TOPIC = /^(?:e?posta|e?mail)(?!er)/; // "mailer.js" bir dosya adıdır, konu değil

const isTopic = (t) => GENERIC_TOPIC.test(t) || SOUND_TOPIC.test(t) || EMAIL_TOPIC.test(t);

/** Bir kelime grubunun hangi kanallardan bahsettiğini bulur. */
function topicsOf(tokens) {
  let sound = false;
  let email = false;
  let generic = false;
  for (const t of tokens) {
    if (SOUND_TOPIC.test(t)) sound = true;
    else if (EMAIL_TOPIC.test(t)) email = true;
    else if (GENERIC_TOPIC.test(t)) generic = true;
  }
  // "sesli bildirim" / "e-posta bildirimi" -> yalnızca belirtilen kanal.
  if (generic && !sound && !email) return { sound: true, email: true };
  return { sound, email };
}

// --- Doğrudan işaretler ("sessiz", "bildirimsiz", "mailsiz") ------------------
const DIRECT_OFF = [
  { re: /^(?:sessiz|sesiz|silent|quiet)\w*$/, sound: true, email: false },
  { re: /^(?:geri)?bildirimsiz\w*$/, sound: true, email: true },
  { re: /^(?:e?posta|e?mail)s[iu]z\w*$/, sound: false, email: true },
];

// --- Türkçe fiiller (konu ÖNCE gelir: "e-posta gönderme", "ses çal") ----------
const TR_OFF_VERB =
  /^(?:gonderme|yollama|atma|calma|cikarma|kullanma)(?:yin|yiniz|sin|sinler|sinlar)?$/;
const TR_OFF_OTHER =
  /^(?:gonderilmesin|kullanilmasin|istemiyor\w*|istemem\w*|istemez\w*|olmasin|gerekmez|gereksiz|kapat|kapatin|kapatiniz|kapatabilirsin\w*|kapali|kapansin|sustur\w*|iptal|yok|kalsin)$/;
const TR_OFF_STATE = /^(?:kapat\w*|kapali|kapansin|sustur\w*)$/; // durum değiştirir -> kalıcı
const TR_ON_VERB =
  /^(?:gonder|gonderin|gonderiniz|gondersin|gonderilsin|gonderebilirsin\w*|at|atin|atsin|atabilirsin\w*|yolla|yollayin|yollasin|yollayabilirsin\w*|cal|calin|calsin|calabilirsin\w*|kullan|kullanin|kullanabilirsin\w*|ac|acin|acsin|acilsin|acabilirsin\w*|istiyorum|isterim|olsun|yeter)$/;
const TR_ON_STATE = /^(?:ac|acin|acsin|acilsin|acabilirsin\w*)$/;
// Genel anlamlı fiiller ("sesli geri dönüş yap", "sesli cevap ver", "ses gelsin"):
// yanlış eşleşmeyi önlemek için yalnızca hemen önceki kelimelere bakılır.
const TR_ON_WEAK = /^(?:yap|yapin|yaparak|ver|verin|vererek|gelsin)$/;
const TR_OFF_WEAK = /^(?:yapma|yapmayin|yapmasin|verme|vermeyin|vermesin)$/;
const WEAK_WINDOW = 2;
// "gönderme özelliği", "mail atma işlemi", "kullanma kılavuzu" gibi isim kullanımları.
const NOUN_AFTER =
  /^(?:ozellig|fonksiyon|islev|islem|kod|mantig|modul|kism|sistem|ayar|sorun|hata|olay|script|betig|akis|mekanizma|arac|kilavuz)/;

function isTrOff(tokens, i) {
  const t = tokens[i];
  if (TR_OFF_VERB.test(t)) return !NOUN_AFTER.test(tokens[i + 1] ?? '');
  if (TR_OFF_OTHER.test(t)) return true;
  if (t === 'degil') return /^(?:lazim|gerekli)$/.test(tokens[i - 1] ?? '');
  return false;
}

// --- İngilizce (konu SONRA gelir: "don't send email", "play a sound") ---------
function enOff(tokens, i) {
  const t = tokens[i];
  const next = tokens[i + 1] ?? '';
  if (/^(?:dont|no|without|skip|never)$/.test(t)) return { len: 1, state: false };
  if (/^(?:disable|mute|silence)$/.test(t)) return { len: 1, state: true };
  if (t === 'do' && next === 'not') return { len: 2, state: false };
  if (t === 'turn' && turnParticle(tokens, i) === 'off') return { len: 1, state: true };
  if (t === 'stop' && next.startsWith('send')) return { len: 2, state: true };
  return null;
}

// "turn off", "turn notifications back on" -> 'off' / 'on'
function turnParticle(tokens, i) {
  for (let k = i + 1; k < tokens.length && k <= i + 4; k++) {
    if (tokens[k] === 'on' || tokens[k] === 'off') return tokens[k];
    if (HARD_STOP.test(tokens[k])) break;
  }
  return null;
}

function enOn(tokens, i) {
  const t = tokens[i];
  const next = tokens[i + 1] ?? '';
  if (/^(?:send|play)$/.test(t)) return { len: 1, state: false };
  if (/^(?:enable|resume|unmute)$/.test(t)) return { len: 1, state: true };
  if (t === 'turn' && turnParticle(tokens, i) === 'on') return { len: 1, state: true };
  return null;
}

// --- Parçalama ----------------------------------------------------------------
const HARD_STOP = /^(?:[.!?;:\n]|ama|fakat|ancak|lakin|but|however)$/;
const LIST_SEP = /^(?:,|ve|ile|veya|yahut|and|or|nor)$/;
const FILLER = /^(?:the|a|an|any|my|me|also|too|de|da|hic|hicbir|herhangi|bir)$/;
// Konu ile fiil arasına girebilen, mesafeye sayılmayan kelimeler.
const SKIP =
  /^(?:bu|su|o|bir|herhangi|hic|hicbir|sohbet\w*|oturum\w*|konusma\w*|boyunca|ben|sen|aksini|soyle\w*|kadar|tekrar|yeniden|artik|bundan|simdiden|sonra|simdilik|lutfen|bana|beni|de|da|sakin|kesinlikle|asla|the|a|an|any|my|me|also|too|again|anymore|for|this|rest|of|until|i|now|from)$/;
const NEAR_WINDOW = 5; // fiile en yakın kaç anlamlı kelimeye bakılacağı

/**
 * Fiilden başlayıp `step` yönünde (−1 geri, +1 ileri) yürür ve cümle sınırına
 * kadar olan kısmı liste ayraçlarına (",", "ve", "and"...) göre parçalar.
 * parts[0] fiile en yakın parçadır; parça içindeki kelimeler de yakınlık sırasıyladır.
 */
function collectParts(tokens, start, step) {
  const parts = [[]];
  for (let j = start; j >= 0 && j < tokens.length; j += step) {
    const t = tokens[j];
    if (HARD_STOP.test(t)) break;
    if (LIST_SEP.test(t)) {
      parts.push([]);
      continue;
    }
    parts[parts.length - 1].push(t);
  }
  return parts;
}

function nearest(part, window) {
  const out = [];
  for (const t of part) {
    if (SKIP.test(t)) continue;
    out.push(t);
    if (out.length >= window) break;
  }
  return out;
}

function topicsNear(parts, chainOk, window = NEAR_WINDOW) {
  const found = topicsOf(nearest(parts[0], window));
  // "sesli ve e-posta gönderme", "don't send email or sound" gibi listeler.
  for (let k = 1; k < parts.length && chainOk(parts[k]); k++) {
    const t = topicsOf(parts[k]);
    found.sound ||= t.sound;
    found.email ||= t.email;
  }
  return found;
}

// Türkçe listeler isimle biter: "hiçbir şekilde e-posta, ses gönderme".
const trChainOk = (part) => part.length > 0 && isTopic(part[0]);
// İngilizce listede parça tamamen konu kelimelerinden oluşmalı: "... email or sound".
const enChainOk = (part) =>
  part.some(isTopic) && part.every((t) => isTopic(t) || FILLER.test(t));

// --- "sadece X" ---------------------------------------------------------------
const ONLY = /^(?:sadece|yalnizca|yalniz|only|just)$/;
const EN_VERB = /^(?:send|play|use|do)$/;

/** "sadece ses gönder" -> { sound: true, email: false }; uygun değilse null. */
function onlyTarget(tokens, i) {
  const group = [];
  let j = i + 1;
  for (; j < tokens.length && j <= i + 6; j++) {
    const u = tokens[j];
    if (isTopic(u)) group.push(u);
    else if (FILLER.test(u) || LIST_SEP.test(u) || EN_VERB.test(u) || SKIP.test(u)) continue;
    else break;
  }
  // "email only"
  if (!group.length && tokens[i] === 'only') {
    for (let k = i - 1; k >= 0 && k >= i - 4; k--) {
      const u = tokens[k];
      if (isTopic(u)) group.push(u);
      else if (!(FILLER.test(u) || LIST_SEP.test(u))) break;
    }
    j = i + 1;
  }
  if (!group.length) return null;
  // "sadece sesi çalma" -> "sadece" olumsuzluğu niteliyor; burada işleme.
  if (isTrOff(tokens, j) || enOff(tokens, j)) return null;
  return topicsOf(group);
}

// --- Kalıcılık işaretleri -----------------------------------------------------
const PERSIST_TOKEN =
  /^(?:sohbet\w*|oturum\w*|konusma(?:da|nin|yi|mizda|mizin)?|artik|kalici\w*|surekli|daima|session|conversation|chat|anymore|always)$/;
const PERSIST_PHRASE =
  /\b(?:soyle\w*\s+kadar|ac\w*\s+kadar|(?:bundan|simdiden)\s+(?:sonra|boyle)|from\s+now|until\s+(?:i|further|told)|rest\s+of)\b/;
const PERSIST_OFF_ONLY = /^(?:asla|never)$/; // "asla gönderme"
const PERSIST_ON_ONLY = /^(?:tekrar|yeniden|again)$/; // "bildirimleri tekrar aç"

/** Tek bir kullanıcı mesajındaki bildirim tercihlerini çıkarır. */
export function detectPreferences(text) {
  const norm = normalize(text);
  const tokens = tokenize(norm);
  const off = { sound: false, email: false };
  const on = { sound: false, email: false };
  const stateful = { sound: false, email: false }; // "kapat" / "aç" gibi durum fiilleri

  const mark = (target, topics, isState) => {
    for (const ch of CHANNELS) {
      if (!topics[ch]) continue;
      target[ch] = true;
      if (isState) stateful[ch] = true;
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    for (const d of DIRECT_OFF) if (d.re.test(t)) mark(off, d, false);

    if (isTrOff(tokens, i)) {
      mark(off, topicsNear(collectParts(tokens, i - 1, -1), trChainOk), TR_OFF_STATE.test(t));
    } else if (TR_OFF_WEAK.test(t) && !NOUN_AFTER.test(tokens[i + 1] ?? '')) {
      mark(off, topicsNear(collectParts(tokens, i - 1, -1), trChainOk, WEAK_WINDOW), false);
    } else if (TR_ON_VERB.test(t)) {
      mark(on, topicsNear(collectParts(tokens, i - 1, -1), trChainOk), TR_ON_STATE.test(t));
    } else if (TR_ON_WEAK.test(t)) {
      mark(on, topicsNear(collectParts(tokens, i - 1, -1), trChainOk, WEAK_WINDOW), false);
    }

    const eOff = enOff(tokens, i);
    if (eOff) mark(off, topicsNear(collectParts(tokens, i + eOff.len, +1), enChainOk), eOff.state);
    const eOn = !eOff && enOn(tokens, i);
    if (eOn) mark(on, topicsNear(collectParts(tokens, i + eOn.len, +1), enChainOk), eOn.state);

    if (ONLY.test(t)) {
      const target = onlyTarget(tokens, i);
      if (target) {
        mark(on, target, false);
        mark(off, { sound: !target.sound, email: !target.email }, false);
      }
    }
  }

  const general = tokens.some((t) => PERSIST_TOKEN.test(t)) || PERSIST_PHRASE.test(norm);
  const offOnly = tokens.some((t) => PERSIST_OFF_ONLY.test(t));
  const onOnly = tokens.some((t) => PERSIST_ON_ONLY.test(t));

  const result = { sound: null, email: null, persist: { sound: false, email: false } };
  for (const ch of CHANNELS) {
    // Çelişki varsa (aynı kanal hem istenip hem reddedildi) susturmak daha güvenli.
    const pref = off[ch] ? 'off' : on[ch] ? 'on' : null;
    result[ch] = pref;
    result.persist[ch] =
      pref !== null &&
      (stateful[ch] || general || (pref === 'off' && offOnly) || (pref === 'on' && onOnly));
  }
  return result;
}

/**
 * Bir sohbetteki kullanıcı mesajlarını (eskiden yeniye) işler ve son tur için
 * karar verir. Kalıcı tercihler sonraki turlara taşınır; son mesajdaki açık
 * tercih (kalıcı olmasa da) o tur için her şeyin önüne geçer.
 *
 * Dönüş: { sound: { send, reason }, email: { send, reason } }
 */
export function decide(prompts) {
  const session = { sound: 'on', email: 'on' };
  let last = { sound: null, email: null, persist: { sound: false, email: false } };

  prompts.forEach((prompt, idx) => {
    const pref = detectPreferences(prompt);
    for (const ch of CHANNELS) if (pref.persist[ch]) session[ch] = pref[ch];
    if (idx === prompts.length - 1) last = pref;
  });

  const out = {};
  for (const ch of CHANNELS) {
    const value = last[ch] ?? session[ch];
    let reason;
    if (last[ch]) reason = last.persist[ch] ? 'son mesajda (sohbet boyunca)' : 'son mesajda (bu tur)';
    else if (session[ch] === 'off') reason = 'sohbette daha önce kapatıldı';
    else reason = 'varsayılan';
    out[ch] = { send: value === 'on', reason };
  }
  return out;
}
