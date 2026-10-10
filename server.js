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

// خريطة لتخزين اتصالات المكاتب الشغالة في الذاكرة
const activeSessions = new Map();

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
    printQRInTerminal: true, // هينزل الكيو آر كمان في الترمينال للتأكد
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

    // إرسال الـ QR Code للفايربيس كصورة Base64
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

    // تم الاتصال والاقتران بنجاح
    if (connection === 'open') {
      console.log(`🎉 ✅ تم اتصال الواتساب بنجاح للمدير: ${managerId}`);
      await db.collection('managers').doc(managerId).set({
        whatsappStatus: 'CONNECTED',
        isWhatsappActive: true,
        whatsappQR: null,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }

    // التعامل مع انقطاع الاتصال المؤقت
    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      
      console.log(`⚠️ إعادة محاولة الاتصال للمدير [${managerId}] - الكود: ${statusCode}`);

      if (isLoggedOut) {
        console.log(`🚫 تم تسجيل الخروج من الجهاز للمدير: ${managerId}`);
        activeSessions.delete(managerId);
        await db.collection('managers').doc(managerId).set({
          whatsappStatus: 'DISCONNECTED',
          isWhatsappActive: false,
          whatsappQR: null,
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });

        if (fs.existsSync(sessionDir)) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
      } else {
        // إعادة المحاولة التلقائية بدون تحويل الحالة لـ DISCONNECTED
        setTimeout(() => startManagerSession(managerId), 3000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

// خريطة لتسجيل توقيت آخر رسالة تم الرد فيها على العميل
 const lastRepliedTime = new Map();

  // ب. التسمع على رسائل العملاء الواردة
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue; // يتجاهل رسائل صاحب الرقم نفسه

      const fromPhone = msg.key.remoteJid;
      // تنظيف رقم الهاتف وإزالة الامتدادات
      const cleanPhone = fromPhone.split('@')[0].split(':')[0];

      const customerKey = `${managerId}_${cleanPhone}`;
      const now = Date.now();
      const threeMinutesInMs = 3 * 60 * 1000; // ⏱️ تم التعديل إلى 3 دقائق بالميللي ثانية

      // ⏱️ فحص مهلة الـ 3 دقائق
      if (lastRepliedTime.has(customerKey)) {
        const lastTime = lastRepliedTime.get(customerKey);
        if (now - lastTime < threeMinutesInMs) {
          console.log(`ℹ️ العميل [${cleanPhone}] أرسل رسالة خلال مهلة الـ 3 دقائق - تم تخطي الرد الآلي لتسهيل المحادثة المباشرة.`);
          continue;
        }
      }

      // جلب بيانات وإعدادات المدير من الفايربيس
      const managerDoc = await db.collection('managers').doc(managerId).get();
      const managerData = managerDoc.data() || {};

      // التأكد من تفعيل خدمة الواتساب للمدير
      if (!managerData.isWhatsappActive) continue;

      // 1. سحب اسم الشركة أو اسم المكتب
      const companyName = managerData.managerName || 'خدمة التوصيل السريع';
      
      // 2. سحب رابط اللوجو الخاص بالمدير
      const logoUrl = managerData.logoUrl || null;

      console.log(`📩 رسالة جديدة من [${cleanPhone}] لشركة [${companyName}] - جاري إرسال الرد الآلي...`);

      // تجهيز روابط الطلب
const baseUrl = "https://delivery1-pi.vercel.app";
      const restaurantUrl = `${baseUrl}?phone=${cleanPhone}&manager=${managerId}&type=restaurant`;
      const packageUrl = `${baseUrl}?phone=${cleanPhone}&manager=${managerId}&type=package`;

      // 🌟 نص الرسالة الترحيبية بتنسيق احترافي وعالمي
      const messageText = 
`✨ *مرحباً بك في ${companyName}* ✨

تسعدنا خدمتك! يرجى اختيار الخدمة المطلوبة لبدء الطلب فوراً:

──────────────────

🛍️ *طلب من مطعم أو محل تجاري*
انقر على الرابط التالي لتحديد طلبك:
🔗 ${restaurantUrl}

📦 *إرسال طرد أو شحنة خاصة*
انقر على الرابط التالي لتحديد تفاصيل الشحنة:
🔗 ${packageUrl}

──────────────────
⚡ *خدمة توصيل فورية وآمنة*`;

      // 🖼️ إرسال الرسالة مع اللوجو لو كان موجوداً، أو كنص فقط لو لم يوجد
      if (logoUrl && logoUrl.trim() !== '') {
        await sock.sendMessage(fromPhone, {
          image: { url: logoUrl },
          caption: messageText
        });
      } else {
        await sock.sendMessage(fromPhone, { text: messageText });
      }

      // تحديث وقت آخر رد للعميل ليتم احتساب الـ 3 دقائق بداية من الآن
      lastRepliedTime.set(customerKey, now);
    }
  });
}

// ===================================================
// 📡 المراقبة اللحظية لطلبات الـ QR من الفايربيس
// ===================================================
console.log("👀 السيرفر يراقب طلبات الـ QR من تطبيق الفلاتر...");

db.collection('managers').onSnapshot(snapshot => {
  snapshot.docChanges().forEach(change => {
    if (change.type === 'added' || change.type === 'modified') {
      const data = change.doc.data();
      const managerId = change.doc.id;

      if (data.whatsappStatus === 'REQUEST_QR' && !activeSessions.has(managerId)) {
        console.log(`🚀 جاري طلب توليد QR للمدير: ${managerId}`);
        startManagerSession(managerId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ سيرفر Node.js شغال بنجاح على البورت ${PORT}`);
});
