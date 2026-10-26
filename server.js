const express = require('express');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const QRCode = require('qrcode');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');

// 1. تهيئة الفايربيس من Environment Variables
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();
const app = express();
app.use(cors());
app.use(express.json());

// 🌐 نقطة نهاية (Endpoint) للرد على فحص UptimeRobot وإبقاء السيرفر نشطاً بدون خطأ 404
app.get('/', (req, res) => {
  res.status(200).send('WhatsApp Server is running successfully! 🚀');
});

// خريطة لتخزين اتصالات المكاتب الشغالة في الذاكرة
const activeSessions = new Map();

// 🕒 دالة للتحقق مما إذا كان الوقت الحالي يقع ضمن مواعيد العمل
function isWithinWorkingHours(openStr, closeStr) {
  if (!openStr || !closeStr) return true;
  try {
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    function parseMinutes(timeStr) {
      const cleanStr = timeStr.trim().toUpperCase();
      const isPM = cleanStr.includes('PM');
      const isAM = cleanStr.includes('AM');

      const formatted = cleanStr.replace(/[^\d:]/g, '').trim();
      const parts = formatted.split(':');

      let hour = parseInt(parts[0], 10) || 0;
      const minute = parseInt(parts[1], 10) || 0;

      if (isPM && hour < 12) hour += 12;
      if (isAM && hour === 12) hour = 0;

      return hour * 60 + minute;
    }

    const openMinutes = parseMinutes(openStr);
    const closeMinutes = parseMinutes(closeStr);

    if (closeMinutes < openMinutes) {
      return currentMinutes >= openMinutes || currentMinutes < closeMinutes;
    } else {
      return currentMinutes >= openMinutes && currentMinutes < closeMinutes;
    }
  } catch (e) {
    console.error("خطأ في التحقق من وقت العمل:", e);
    return true;
  }
}

// ===================================================
// 🛠️ دالة تشغيل جلسة الواتساب وتوليد الـ QR لمدير معين
// ===================================================
async function startManagerSession(managerId) {
  const sessionDir = path.join(__dirname, 'sessions', `session_${managerId}`);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  // إعدادات اتصال متكيفة ومستقرة
  const sock = makeWASocket({
    auth: state,
    browser: ["Delivery System", "Chrome", "1.0.0"],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
  });

  activeSessions.set(managerId, sock);

  // أ. التسمع على حالة الاتصال والـ QR Code
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    console.log(`📡 [${managerId}] حالة الاتصال:`, connection || 'جاري المعالجة...', qr ? '📸 تم استخراج QR' : '');

    if (qr) {
      console.log(`📸 جاري حفظ الـ QR في الفايربيس للمدير: ${managerId}`);
      try {
        const qrImageBase64 = await QRCode.toDataURL(qr);
        await db.collection('managers').doc(managerId).set({
          whatsappStatus: 'AWAITING_QR',
          whatsappQR: qrImageBase64,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        console.log(`✅ تم حفظ صورة الـ QR بنجاح في الفايربيس!`);
      } catch (err) {
        console.error(`❌ خطأ أثناء حفظ الـ QR:`, err);
      }
    }

    if (connection === 'open') {
      console.log(`🎉 ✅ تم اتصال الواتساب بنجاح للمدير: ${managerId}`);
      await db.collection('managers').doc(managerId).set({
        whatsappStatus: 'CONNECTED',
        isWhatsappActive: true,
        whatsappQR: null,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }

   if (connection === 'close') {
      const statusCode = (lastDisconnect?.error)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const reason = lastDisconnect?.error?.output?.payload?.error;
      
      console.log(`⚠️ انقطع الاتصال للمدير [${managerId}] - الكود: ${statusCode} - السبب: ${reason}`);

      // حذف الجلسة النشطة من الذاكرة
      activeSessions.delete(managerId);

      if (isLoggedOut || statusCode === DisconnectReason.badSession) {
        console.log(`🚫 تم تسجيل الخروج أو تلف الجلسة للمدير: ${managerId}`);
        await db.collection('managers').doc(managerId).set({
          whatsappStatus: 'DISCONNECTED',
          isWhatsappActive: false,
          whatsappQR: null,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });

        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
          console.log(`🗑️ تم مسح مجلد الجلسة للمدير: ${managerId}`);
        }
      } else {
        // لو الانقطاع مش تسجيل خروج رسمي، بدل ما نفصل الحالة فوراً وتخرب عليك الـ QR، نديله محاولة إعادة اتصال تلقائية ذكية (Reconnect) أو ننتظر ثواني
        console.log(`🔄 محاولة إعادة الاتصال التلقائي للمدير: ${managerId}`);
        setTimeout(() => startManagerSession(managerId), 3000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  const lastRepliedTime = new Map();

  // ب. التسمع على رسائل العملاء الواردة والرد الآلي
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      const fromPhone = msg.key.remoteJid;
      const cleanPhone = fromPhone.split('@')[0].split(':')[0];

      const customerKey = `${managerId}_${cleanPhone}`;
      const now = Date.now();
      const tenMinutesInMs = 5 * 60 * 1000;

      if (lastRepliedTime.has(customerKey)) {
        const lastTime = lastRepliedTime.get(customerKey);
        if (now - lastTime < tenMinutesInMs) {
          console.log(`ℹ️ العميل [${cleanPhone}] أرسل رسالة خلال مهلة الـ 5 دقائق - تم تخطي الرد الآلي.`);
          continue;
        }
      }

      const managerDoc = await db.collection('managers').doc(managerId).get();
      const managerData = managerDoc.data() || {};

      if (!managerData.isWhatsappActive) continue;

      const companyName = managerData.managerName || 'خدمة التوصيل السريع';
      const logoUrl = managerData.logoUrl || null;
      const openTime = managerData.openTime || '';
      const closeTime = managerData.closeTime || '';

      // 🕒 فحص ما إذا كان الوقت الحالي ضمن مواعيد العمل
      const isOpenNow = isWithinWorkingHours(openTime, closeTime);

      console.log(`📩 رسالة جديدة من [${cleanPhone}] لشركة [${companyName}] - جاري إرسال الرد الآلي...`);

      let messageText = "";

      if (!isOpenNow) {
        // 🛑 رسالة الإغلاق وتوضيح ميعاد الفتح
        messageText = `🛑 نأسف، نحن مغلقون حالياً في ${companyName}.\n\n⏰ مواعيد العمل تبدأ من الساعة: ${openTime} وحتى الساعة: ${closeTime}.\n\nسنكون سعداء بخدمتك فور بدأ العمل! 🚀`;
      } else {
        // تجهيز روابط الطلب
      // تجهيز روابط الطلب مع تحديد التبويب المطلوب
const baseUrl = "https://delivery1-pi.vercel.app";
const restaurantUrl = `${baseUrl}?phone=${cleanPhone}&manager=${managerId}&type=restaurant&mode=standard`;
const packageUrl = `${baseUrl}?phone=${cleanPhone}&manager=${managerId}&type=package&mode=parcel`;

        // 🌟 نص الرسالة الترحيبية بتنسيق احترافي وعالمي
        messageText = 
`👋 أهلاً بك في ${companyName}
اختر نوع الخدمة لنبدأ فوراً:
🛍️للطلبات والمشاوير:
إضغط هنا 👇
${restaurantUrl}
📦 لإرسال طرد أو شحنة:
إضغط هنا 👇
${packageUrl}`;
      }

      if (logoUrl && logoUrl.trim() !== '') {
        await sock.sendMessage(fromPhone, {
          image: { url: logoUrl },
          caption: messageText
        });
      } else {
        await sock.sendMessage(fromPhone, { text: messageText });
      }

      lastRepliedTime.set(customerKey, now);
    }
  });
}

// ===================================================
// 📡 المراقبة اللحظية لطلبات الـ QR والـ LOGOUT من الفايربيس
// ===================================================
console.log("👀 السيرفر يراقب طلبات المكاتب من تطبيق الفلاتر...");

db.collection('managers').onSnapshot(snapshot => {
  snapshot.docChanges().forEach(async change => {
    if (change.type === 'added' || change.type === 'modified') {
      const data = change.doc.data();
      const managerId = change.doc.id;
      const sessionDir = path.join(__dirname, 'sessions', `session_${managerId}`);

      // 1. طلب توليد QR جديد
      if (data.whatsappStatus === 'REQUEST_QR' && !activeSessions.has(managerId)) {
        console.log(`🚀 جاري طلب توليد QR للمدير: ${managerId}`);
        startManagerSession(managerId);
      }

      // 2. طلب فصل وتسجيل خروج الهاتف (LOGOUT) 🔌
      if (data.whatsappStatus === 'LOGOUT') {
        console.log(`🔌 تم استلام طلب فصل الواتساب للمدير: ${managerId}`);
        
        if (activeSessions.has(managerId)) {
          const sock = activeSessions.get(managerId);
          try {
            await sock.logout();
            sock.end(undefined);
          } catch (e) {
            console.log("خطأ أثناء إغلاق السوكيت:", e);
          }
          activeSessions.delete(managerId);
        }

        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
          console.log(`🗑️ تم مسح مجلد الجلسة بنجاح للمدير: ${managerId}`);
        }

        await db.collection('managers').doc(managerId).set({
          whatsappStatus: 'DISCONNECTED',
          isWhatsappActive: false,
          whatsappQR: null,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ سيرفر Node.js شغال بنجاح على البورت ${PORT}`);
});

// 🔄 كود إبقاء السيرفر نشطاً لمنع النوم (Keep-Alive) كل 5 دقائق
const https = require('https');
const SELF_URL = 'https://whatsapp-server-vtjg.onrender.com';
setInterval(() => {
  https.get(SELF_URL, (res) => {
    console.log(`⚡ تم عمل Ping للسيرفر للحفاظ على نشاطه - الحالة: ${res.statusCode}`);
  }).on('error', (err) => {
    console.error(`❌ خطأ أثناء عمل Ping للسيرفر: ${err.message}`);
  });
}, 5 * 60 * 1000);
