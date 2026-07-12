const path = require('path');
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const nodemailer = require('nodemailer');

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if(!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(__dirname));

// Optional payment SDKs (only used if env vars present and packages installed)
let stripe = null;
try{
  if(process.env.STRIPE_SECRET_KEY) stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}catch(e){ console.log('Stripe not available:', e.message); }

let paypalClient = null;
try{
  if(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET){
    const checkout = require('@paypal/checkout-server-sdk');
    const environment = new checkout.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET);
    paypalClient = new checkout.core.PayPalHttpClient(environment);
  }
}catch(e){ console.log('PayPal SDK not available:', e.message); }

// helpers
function readJSON(name, fallback) {
  const p = path.join(DATA_DIR, name);
  if(!fs.existsSync(p)) { fs.writeFileSync(p, JSON.stringify(fallback || {})); }
  return JSON.parse(fs.readFileSync(p,'utf8'));
}
function writeJSON(name, data) { fs.writeFileSync(path.join(DATA_DIR,name), JSON.stringify(data, null, 2)); }
function computeOrderTotal(order, menuItems) {
  const items = order.items || [];
  return items.reduce((sum, item) => {
    const menuItem = menuItems.find(m => m.id === item.menu_item_id);
    return sum + (menuItem ? (Number(menuItem.price) || 0) * (Number(item.quantity) || 0) : 0);
  }, 0);
}

function createOrderRecord(orderData) {
  const orders = readJSON('orders.json', []);
  const menuItems = readJSON('menu.json', []);
  const id = (orders.length ? orders[orders.length-1].id : 0) + 1;
  const total = computeOrderTotal(orderData, menuItems);
  const record = Object.assign({
    id,
    status: 'pending',
    payment_provider: orderData.payment_provider || null,
    payment_method: orderData.payment_method || null,
    payment_status: orderData.payment_provider ? 'pending' : 'pending',
    payment_reference: null,
    created_at: new Date().toISOString(),
    total
  }, orderData);
  orders.push(record);
  writeJSON('orders.json', orders);
  return record;
}

function updateOrderPaymentStatus(localOrderId, status, paymentReference, provider) {
  const orders = readJSON('orders.json', []);
  const order = orders.find(x => x.id === Number(localOrderId));
  if(!order) return null;
  order.status = status;
  order.payment_status = status === 'paid' ? 'paid' : order.payment_status || status;
  if(paymentReference) order.payment_reference = paymentReference;
  if(provider) order.payment_provider = provider;
  writeJSON('orders.json', orders);
  return order;
}

function findLocalOrderIdFromPayPalResource(resource) {
  if(!resource) return null;
  const customId = resource.purchase_units && resource.purchase_units[0] && resource.purchase_units[0].custom_id;
  if(customId) return Number(customId);
  if(resource.custom_id) return Number(resource.custom_id);
  if(resource.supplementary_data && resource.supplementary_data.related_ids && resource.supplementary_data.related_ids.order_id) {
    return Number(resource.supplementary_data.related_ids.order_id);
  }
  return null;
}

function computeDashboardFromOrders(orders, menuItems, opts={}){
  const { startDate, endDate } = opts;
  const inRange = (o)=>{
    if(!startDate && !endDate) return true;
    if(!o.created_at) return false;
    const d = new Date(o.created_at);
    if(startDate && d < startDate) return false;
    if(endDate && d > endDate) return false;
    return true;
  };
  const filtered = orders.filter(inRange);
  const total_revenue = filtered.reduce((sum,o)=>{
    const t = Number(o.total) || 0;
    return sum + t;
  },0);
  const total_orders = filtered.length;
  const pending_orders = filtered.filter(o=>o.status==='pending').length;
  const counts = filtered.reduce((map,order)=>{
    (order.items||[]).forEach(item=>{
      map[item.menu_item_id] = (map[item.menu_item_id]||0) + (item.quantity||0);
    });
    return map;
  }, {});
  const popular_items = Object.entries(counts)
    .sort((a,b)=>b[1]-a[1])
    .slice(0,5)
    .map(([menu_item_id,quantity])=>{
      const menuItem = menuItems.find(m=>m.id === Number(menu_item_id)) || {name:'Unknown item'};
      return { name: menuItem.name, quantity };
    });
  return { total_revenue, total_orders, pending_orders, popular_items };
}

// Email sending function
function sendNotificationEmail(to, subject, htmlContent) {
  if (!to) {
    console.log('No email recipient provided');
    return Promise.resolve();
  }

  // Use Gmail or other SMTP service via environment variables
  const smtpConfig = {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: process.env.SMTP_PORT || 587,
    secure: process.env.SMTP_SECURE === 'true' || false,
    auth: {
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || ''
    }
  };

  // If no SMTP credentials, log and return (silently fail)
  if (!smtpConfig.auth.user || !smtpConfig.auth.pass) {
    console.log('Email sending not configured. Set SMTP_USER and SMTP_PASS environment variables.');
    return Promise.resolve();
  }

  const transporter = nodemailer.createTransport(smtpConfig);
  
  return transporter.sendMail({
    from: smtpConfig.auth.user,
    to,
    subject,
    html: htmlContent
  }).then(info => {
    console.log('Email sent:', info.response);
  }).catch(err => {
    console.error('Failed to send email:', err.message);
  });
}

// API Key Authentication
function getValidApiKeys() {
  try {
    const settings = readJSON('settings.json', sampleSettings);
    return settings.api_keys || {};
  } catch(e) {
    return {};
  }
}

// Middleware to check API key
function validateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  
  if(!apiKey) {
    return res.status(401).json({ detail: 'API key required' });
  }
  
  const validKeys = getValidApiKeys();
  
  // Check if key exists and is active
  if(!validKeys[apiKey] || !validKeys[apiKey].active) {
    return res.status(401).json({ detail: 'Invalid or inactive API key' });
  }
  
  // Attach key info to request for logging
  req.apiKey = apiKey;
  req.apiKeyInfo = validKeys[apiKey];
  next();
}

function getUserFromToken(token) {
  if(!token || typeof token !== 'string') return null;
  const match = token.match(/^token-(\d+)$/);
  if(!match) return null;
  const users = readJSON('users.json', []);
  return users.find(u => u.id === Number(match[1])) || null;
}

function validateAdminOrApiKey(req, res, next) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if(authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    const user = getUserFromToken(token);
    if(user && user.role === 'admin') {
      req.user = user;
      return next();
    }
  }

  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if(apiKey) {
    const validKeys = getValidApiKeys();
    if(validKeys[apiKey] && validKeys[apiKey].active) {
      req.apiKey = apiKey;
      req.apiKeyInfo = validKeys[apiKey];
      return next();
    }
  }

  return res.status(401).json({ detail: 'Unauthorized access' });
}

// sample data
const sampleMenu = [
  {id:1,name:'West Texas Burger',description:'Juicy beef patty',price:13.95,calories:780,category_id:1,is_featured:true,is_popular:true,is_spicy:false,is_available:true,allergens:'gluten, dairy'}
];
const sampleCats = [{id:1,name:'Burgers',icon:'🍔'},{id:2,name:'Cocktails',icon:'🍸'}];
const sampleSettings = { admin_email:'', hero_image:null, hero_images:[], photo_strip_1:null, photo_strip_2:null, photo_strip_3:null, cocktail_banner_image:null, menu_bg_image:null, gallery_image_1:null, gallery_image_2:null, gallery_image_3:null, gallery_image_4:null, gallery_images:[] };
const sampleUsers = [{ id:1, name:'Admin User', email:'admin@westtexas.com', phone:'806-000-0000', password:'password', role:'admin' }];
const sampleNews = [
  {id:1,title:'Grand Opening Celebration!',description:'Join us for an unforgettable grand opening weekend with exclusive cocktails and live music!',category:'event',image:null,date:'2026-07-15',highlight:true,created_at:'2026-06-29T00:00:00Z'},
  {id:2,title:'New Summer Menu Available',description:'Explore our exciting new summer menu featuring fresh ingredients and creative seasonal dishes.',category:'menu',image:null,date:'2026-06-25',highlight:false,created_at:'2026-06-25T00:00:00Z'}
];

// ensure data files
readJSON('menu.json', sampleMenu);
readJSON('categories.json', sampleCats);
readJSON('settings.json', sampleSettings);
readJSON('orders.json', []);
readJSON('reservations.json', []);
readJSON('reviews.json', []);
readJSON('users.json', sampleUsers);
readJSON('news.json', sampleNews);
readJSON('careers.json', []);

function parseBoolean(value) {
  if(typeof value === 'boolean') return value;
  if(typeof value === 'string') {
    if(value.toLowerCase() === 'true') return true;
    if(value.toLowerCase() === 'false') return false;
  }
  return Boolean(value);
}

function normalizeMenuPayload(body, uploadedFile) {
  const payload = {};
  if(!body || typeof body !== 'object' || Array.isArray(body)) return payload;
  if(body.name !== undefined) payload.name = body.name;
  if(body.category_id !== undefined) payload.category_id = Number(body.category_id);
  if(body.price !== undefined) payload.price = Number(body.price);
  if(body.description !== undefined) payload.description = body.description || null;
  if(body.calories !== undefined) payload.calories = body.calories === '' || body.calories === null ? null : Number(body.calories);
  if(body.allergens !== undefined) payload.allergens = body.allergens || null;
  if(body.is_featured !== undefined) payload.is_featured = parseBoolean(body.is_featured);
  if(body.is_popular !== undefined) payload.is_popular = parseBoolean(body.is_popular);
  if(body.is_spicy !== undefined) payload.is_spicy = parseBoolean(body.is_spicy);
  if(body.weekly_special !== undefined) payload.weekly_special = parseBoolean(body.weekly_special);
  if(body.is_available !== undefined) payload.is_available = parseBoolean(body.is_available);
  if(uploadedFile) payload.image = '/uploads/' + uploadedFile.filename;
  if(body.image && !uploadedFile) payload.image = body.image;
  return payload;
}

// API routes
app.get('/api/menu/items', (req,res)=>{
  const items = readJSON('menu.json', sampleMenu);
  res.json(items);
});
app.get('/api/menu/categories', (req,res)=>{
  const cats = readJSON('categories.json', sampleCats);
  res.json(cats);
});

app.post('/api/menu/categories', (req,res)=>{
  const cats = readJSON('categories.json', sampleCats);
  const body = req.body || {};
  const name = (body.name || '').trim();
  if(!name) return res.status(400).json({detail:'Category name is required'});
  const slug = (body.slug || '').trim() || name.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_\-]/g,'');
  const record = {
    id: (cats.length ? cats[cats.length - 1].id : 0) + 1,
    name,
    slug,
    icon: body.icon || '🍽️',
    sort_order: Number(body.sort_order || 0)
  };
  cats.push(record);
  cats.sort((a,b)=> (Number(a.sort_order)||0) - (Number(b.sort_order)||0) || a.name.localeCompare(b.name));
  writeJSON('categories.json', cats);
  res.json(record);
});

app.put('/api/menu/categories/:id', (req,res)=>{
  const cats = readJSON('categories.json', sampleCats);
  const id = Number(req.params.id);
  const cat = cats.find(x=>x.id===id);
  if(!cat) return res.status(404).json({detail:'Category not found'});
  const body = req.body || {};
  if(body.name !== undefined) cat.name = (body.name || '').trim();
  if(body.slug !== undefined) cat.slug = (body.slug || '').trim() || cat.name.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_\-]/g,'');
  if(body.icon !== undefined) cat.icon = body.icon || '🍽️';
  if(body.sort_order !== undefined) cat.sort_order = Number(body.sort_order || 0);
  cats.sort((a,b)=> (Number(a.sort_order)||0) - (Number(b.sort_order)||0) || a.name.localeCompare(b.name));
  writeJSON('categories.json', cats);
  res.json(cat);
});

app.delete('/api/menu/categories/:id', (req,res)=>{
  let cats = readJSON('categories.json', sampleCats);
  const id = Number(req.params.id);
  if(!cats.some(x=>x.id===id)) return res.status(404).json({detail:'Category not found'});
  cats = cats.filter(x=>x.id!==id);
  writeJSON('categories.json', cats);
  res.json({ok:true});
});

app.get('/api/settings', (req,res)=>{
  const s = Object.assign({}, sampleSettings, readJSON('settings.json', sampleSettings));
  res.json(s);
});

// file upload for settings images
const storage = multer.diskStorage({
  destination: (req,file,cb) => cb(null, UPLOADS_DIR),
  filename: (req,file,cb) => {
    const fn = Date.now() + '-' + file.originalname.replace(/\s+/g,'_');
    cb(null, fn);
  }
});
const upload = multer({storage});

app.post('/api/settings/upload-image/:slot', upload.single('file'), (req,res)=>{
  const slot = req.params.slot;
  if(!req.file) return res.status(400).json({detail:'No file uploaded'});
  const rel = '/uploads/' + req.file.filename;
  const s = Object.assign({}, sampleSettings, readJSON('settings.json', sampleSettings));
  if(slot === 'gallery_images' || slot === 'hero_images') {
    const target = slot === 'hero_images' ? 'hero_images' : 'gallery_images';
    if(!Array.isArray(s[target])) s[target] = [];
    s[target].push(rel);
    writeJSON('settings.json', s);
    return res.json({slot: target, url: rel, index: s[target].length - 1});
  }
  s[slot] = rel;
  writeJSON('settings.json', s);
  res.json({slot, url: rel});
});
app.delete('/api/settings/image/:slot', (req,res)=>{
  const slot = req.params.slot;
  const index = req.query.index !== undefined ? Number(req.query.index) : null;
  const s = Object.assign({}, sampleSettings, readJSON('settings.json', sampleSettings));
  if(slot === 'gallery_images' || slot === 'hero_images') {
    const target = slot === 'hero_images' ? 'hero_images' : 'gallery_images';
    if(!Array.isArray(s[target])) s[target] = [];
    if(index === null || Number.isNaN(index) || index < 0 || index >= s[target].length) {
      return res.status(400).json({detail:'Invalid image index'});
    }
    s[target].splice(index, 1);
    writeJSON('settings.json', s);
    return res.json({slot: target, index});
  }
  if(!Object.prototype.hasOwnProperty.call(s, slot)) return res.status(400).json({detail:'Invalid image slot'});
  s[slot] = null;
  writeJSON('settings.json', s);
  res.json({slot});
});
// update arbitrary settings (admin only)
app.put('/api/settings', validateAdminOrApiKey, (req, res) => {
  try {
    const s = Object.assign({}, sampleSettings, readJSON('settings.json', sampleSettings));
    const body = req.body || {};
    // only allow simple keys to be updated
    Object.keys(body).forEach(k => {
      s[k] = body[k];
    });
    writeJSON('settings.json', s);
    res.json(s);
  } catch (err) {
    res.status(500).json({ detail: 'Failed to update settings' });
  }
});
app.get('/api/orders/track/:order_id', (req,res)=>{
  const id = Number(req.params.order_id);
  const orders = readJSON('orders.json', []);
  const menuItems = readJSON('menu.json', []);
  const o = orders.find(x=>x.id===id);
  if(!o) return res.status(404).json({detail:'Not found'});
  o.total = computeOrderTotal(o, menuItems);
  res.json(o);
});

// --- Payments: Stripe Checkout and PayPal ---
const BASE_ORIGIN = process.env.BASE_ORIGIN || 'http://localhost:3000';

app.post('/api/payments/stripe/create-checkout-session', async (req,res)=>{
  if(!stripe) return res.status(501).json({detail:'Stripe not configured on server'});
  const { order } = req.body;
  if(!order || !Array.isArray(order.items) || !order.items.length) return res.status(400).json({detail:'Order payload and items are required'});
  try{
    order.payment_provider = 'stripe';
    const localOrder = createOrderRecord(order);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency: 'usd', product_data:{ name: `Order #${localOrder.id}` }, unit_amount: Math.round(Number(localOrder.total || 0) * 100) }, quantity: 1 }],
      mode: 'payment',
      metadata: { order_id: String(localOrder.id) },
      success_url: `${BASE_ORIGIN}/?stripe_success=1&order_id=${localOrder.id}`,
      cancel_url: `${BASE_ORIGIN}/?stripe_cancel=1&order_id=${localOrder.id}`
    });
    updateOrderPaymentStatus(localOrder.id, 'pending', session.id, 'stripe');
    res.json({ url: session.url, orderId: localOrder.id, sessionId: session.id });
  } catch(e){ console.error(e); res.status(500).json({detail: e.message}); }
});

app.post('/api/payments/paypal/create-order', async (req,res)=>{
  if(!paypalClient) return res.status(501).json({detail:'PayPal not configured on server'});
  const { order } = req.body;
  if(!order || !Array.isArray(order.items) || !order.items.length) return res.status(400).json({detail:'Order payload and items are required'});
  try{
    order.payment_provider = 'paypal';
    const localOrder = createOrderRecord(order);
    const checkout = require('@paypal/checkout-server-sdk');
    const request = new checkout.orders.OrdersCreateRequest();
    request.prefer('return=representation');
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: { currency_code: 'USD', value: String(Number(localOrder.total).toFixed(2)) },
        custom_id: String(localOrder.id),
        description: `Order #${localOrder.id}`
      }],
      application_context: {
        return_url: `${BASE_ORIGIN}/?paypal_return=1&order_id=${localOrder.id}`,
        cancel_url: `${BASE_ORIGIN}/?paypal_cancel=1&order_id=${localOrder.id}`
      }
    });
    const response = await paypalClient.execute(request);
    const approve = response.result.links.find(l=>l.rel==='approve');
    updateOrderPaymentStatus(localOrder.id, 'pending', response.result.id, 'paypal');
    res.json({ id: response.result.id, approveUrl: approve ? approve.href : null, orderId: localOrder.id });
  } catch(e){ console.error(e); res.status(500).json({detail: e.message}); }
});

app.post('/api/payments/paypal/capture-order/:orderId', async (req,res)=>{
  if(!paypalClient) return res.status(501).json({detail:'PayPal not configured on server'});
  try{
    const paypalOrderId = req.params.orderId;
    const checkout = require('@paypal/checkout-server-sdk');
    const request = new checkout.orders.OrdersCaptureRequest(paypalOrderId);
    request.requestBody({});
    const response = await paypalClient.execute(request);
    const resource = response.result;
    const localOrderId = findLocalOrderIdFromPayPalResource(resource) || (req.query.order_id ? Number(req.query.order_id) : null);
    if(localOrderId) updateOrderPaymentStatus(localOrderId, 'paid', paypalOrderId, 'paypal');
    res.json(response.result);
  } catch(e){ console.error(e); res.status(500).json({detail: e.message}); }
});

app.post('/api/payments/stripe/webhook', bodyParser.raw({ type: 'application/json' }), async (req,res)=>{
  if(!stripe) return res.status(501).json({detail:'Stripe not configured on server'});
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if(!secret) return res.status(501).json({detail:'Stripe webhook secret not configured'});
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch(err) {
    console.error('Stripe webhook signature failed:', err.message);
    return res.status(400).json({detail:'Invalid Stripe webhook signature'});
  }
  const data = event.data.object;
  if(event.type === 'checkout.session.completed') {
    const orderId = data.metadata && data.metadata.order_id ? Number(data.metadata.order_id) : null;
    if(orderId) updateOrderPaymentStatus(orderId, 'paid', data.payment_intent || data.id, 'stripe');
  } else if(event.type === 'payment_intent.succeeded') {
    const orderId = data.metadata && data.metadata.order_id ? Number(data.metadata.order_id) : null;
    if(orderId) updateOrderPaymentStatus(orderId, 'paid', data.id, 'stripe');
  }
  res.json({received:true});
});

app.post('/api/payments/paypal/webhook', async (req,res)=>{
  if(!paypalClient) return res.status(501).json({detail:'PayPal not configured on server'});
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if(!webhookId) return res.status(501).json({detail:'PayPal webhook ID not configured'});
  try{
    const checkout = require('@paypal/checkout-server-sdk');
    const request = new checkout.notifications.WebhookVerifySignatureRequest();
    request.requestBody({
      auth_algo: req.headers['paypal-auth-algo'],
      cert_url: req.headers['paypal-cert-url'],
      transmission_id: req.headers['paypal-transmission-id'],
      transmission_sig: req.headers['paypal-transmission-sig'],
      transmission_time: req.headers['paypal-transmission-time'],
      webhook_id: webhookId,
      webhook_event: req.body
    });
    const verification = await paypalClient.execute(request);
    const status = verification.result && verification.result.verification_status;
    if(status !== 'SUCCESS') {
      console.error('PayPal webhook verification failed', status);
      return res.status(400).json({detail:'Invalid PayPal webhook signature'});
    }
  } catch(err) {
    console.error('PayPal webhook verification exception:', err.message);
    return res.status(400).json({detail:'PayPal webhook verification failed'});
  }
  try {
    const eventType = req.body.event_type;
    const resource = req.body.resource || {};
    const localOrderId = findLocalOrderIdFromPayPalResource(resource);
    if(localOrderId && (eventType === 'CHECKOUT.ORDER.APPROVED' || eventType === 'PAYMENT.CAPTURE.COMPLETED' || eventType === 'PAYMENT.SALE.COMPLETED')) {
      const paymentRef = resource.id || (resource.purchase_units && resource.purchase_units[0] && resource.purchase_units[0].payments && resource.purchase_units[0].payments.captures && resource.purchase_units[0].payments.captures[0] && resource.purchase_units[0].payments.captures[0].id);
      updateOrderPaymentStatus(localOrderId, 'paid', paymentRef || resource.id, 'paypal');
    }
    res.json({received:true});
  } catch(err) {
    console.error('PayPal webhook processing exception:', err.message);
    res.status(500).json({detail:'Webhook processing error'});
  }
});

app.post('/api/orders/', (req,res)=>{
  const orders = readJSON('orders.json', []);
  const menuItems = readJSON('menu.json', []);
  const id = (orders.length?orders[orders.length-1].id:0)+1;
  const total = computeOrderTotal(req.body, menuItems);
  const record = Object.assign({id, status:'pending', created_at:new Date().toISOString(), total}, req.body);
  orders.push(record); writeJSON('orders.json', orders);
  
  // Send email notification
  const settings = readJSON('settings.json', sampleSettings);
  if(settings.admin_email) {
    const itemList = (record.items || []).map(item => {
      const menuItem = menuItems.find(m => m.id === item.menu_item_id);
      return `<li>${item.quantity}x ${menuItem ? menuItem.name : 'Unknown Item'} - $${(Number(menuItem?.price||0) * item.quantity).toFixed(2)}</li>`;
    }).join('');
    const html = `
      <h2>New Order Received!</h2>
      <p><strong>Order ID:</strong> #${record.id}</p>
      <p><strong>Customer:</strong> ${record.customer_name || 'Guest'}</p>
      <p><strong>Phone:</strong> ${record.customer_phone || 'N/A'}</p>
      <p><strong>Type:</strong> ${record.order_type || 'Dine-in'}</p>
      <p><strong>Items:</strong></p>
      <ul>${itemList}</ul>
      <p><strong>Total:</strong> $${record.total.toFixed(2)}</p>
      <p><strong>Notes:</strong> ${record.notes || 'None'}</p>
      <p>Please log into the admin panel to manage this order.</p>
    `;
    sendNotificationEmail(settings.admin_email, `New Order #${record.id}`, html);
  }
  
  res.json(record);
});

app.get('/api/orders/', validateAdminOrApiKey, (req,res)=>{
  const menuItems = readJSON('menu.json', []);
  const orders = readJSON('orders.json', []).map(o => ({ ...o, total: computeOrderTotal(o, menuItems) }));
  res.json(orders);
});

app.post('/api/reservations/', (req,res)=>{
  const rs = readJSON('reservations.json', []);
  const id = (rs.length?rs[rs.length-1].id:0)+1;
  const rec = Object.assign({id,status:'pending'}, req.body);
  rs.push(rec); writeJSON('reservations.json', rs);
  
  // Send email notification
  const settings = readJSON('settings.json', sampleSettings);
  if(settings.admin_email) {
    const html = `
      <h2>New Reservation Received!</h2>
      <p><strong>Reservation ID:</strong> #${rec.id}</p>
      <p><strong>Guest Name:</strong> ${rec.name || 'N/A'}</p>
      <p><strong>Phone:</strong> ${rec.phone || 'N/A'}</p>
      <p><strong>Email:</strong> ${rec.email || 'N/A'}</p>
      <p><strong>Date:</strong> ${rec.date || 'N/A'}</p>
      <p><strong>Time:</strong> ${rec.time || 'N/A'}</p>
      <p><strong>Party Size:</strong> ${rec.party_size || 'N/A'}</p>
      <p><strong>Special Requests:</strong> ${rec.notes || 'None'}</p>
      <p>Please log into the admin panel to confirm this reservation.</p>
    `;
    sendNotificationEmail(settings.admin_email, `New Reservation #${rec.id}`, html);
  }
  
  res.json(rec);
});

app.get('/api/reviews/pending', (req,res)=>{
  const r = readJSON('reviews.json', []);
  res.json(r.filter(x=>x.status==='pending'));
});
app.post('/api/reviews/', (req,res)=>{
  const r = readJSON('reviews.json', []);
  const id = (r.length?r[r.length-1].id:0)+1;
  const rec = Object.assign({id, status:'pending', created_at:new Date().toISOString()}, req.body);
  r.push(rec); writeJSON('reviews.json', r);
  
  // Send email notification
  const settings = readJSON('settings.json', sampleSettings);
  if(settings.admin_email) {
    const stars = '★'.repeat(rec.rating || 0) + '☆'.repeat(5 - (rec.rating || 0));
    const html = `
      <h2>New Review Submitted!</h2>
      <p><strong>Review ID:</strong> #${rec.id}</p>
      <p><strong>From:</strong> ${rec.name || 'Anonymous'}</p>
      <p><strong>Rating:</strong> ${stars} (${rec.rating}/5)</p>
      <p><strong>Title:</strong> ${rec.title || 'No title'}</p>
      <p><strong>Review:</strong></p>
      <p>${rec.review || 'No content'}</p>
      <p>Status: <strong>${rec.status}</strong> (pending approval)</p>
      <p>Please log into the admin panel to approve or reject this review.</p>
    `;
    sendNotificationEmail(settings.admin_email, `New Review Submitted - ${rec.rating}/5 Stars`, html);
  }
  
  res.json(rec);
});
app.put('/api/reviews/:review_id/approve', (req,res)=>{
  const reviews = readJSON('reviews.json', []);
  const id = Number(req.params.review_id);
  const review = reviews.find(x=>x.id===id);
  if(!review) return res.status(404).json({detail:'Review not found'});
  review.status = 'approved';
  writeJSON('reviews.json', reviews);
  res.json(review);
});
app.delete('/api/reviews/:review_id', (req,res)=>{
  const reviews = readJSON('reviews.json', []);
  const id = Number(req.params.review_id);
  const index = reviews.findIndex(x=>x.id===id);
  if(index === -1) return res.status(404).json({detail:'Review not found'});
  const [deleted] = reviews.splice(index,1);
  writeJSON('reviews.json', reviews);
  res.json(deleted);
});

app.post('/api/auth/login', (req,res)=>{
  const { username, password } = req.body;
  if(!username||!password) return res.status(400).json({detail:'Username and password required'});
  const users = readJSON('users.json', []);
  const user = users.find(u => u.email.toLowerCase() === username.toLowerCase());
  if(!user || user.password !== password) return res.status(401).json({detail:'Invalid credentials'});
  const safeUser = { id:user.id, name:user.name, email:user.email, phone:user.phone, role:user.role };
  res.json({ access_token:'token-'+user.id, user:safeUser });
});

app.post('/api/auth/register', (req,res)=>{
  const { name, email, phone, password } = req.body;
  if(!name||!email||!phone||!password) return res.status(400).json({detail:'All fields are required'});
  const users = readJSON('users.json', []);
  if(users.some(u => u.email.toLowerCase() === email.toLowerCase())) return res.status(400).json({detail:'Email already registered'});
  const id = (users.length?users[users.length-1].id:0)+1;
  const newUser = { id, name, email:email.toLowerCase(), phone, password, role:'customer' };
  users.push(newUser); writeJSON('users.json', users);
  const safeUser = { id, name, email:email.toLowerCase(), phone, role:'customer' };
  res.json({ access_token:'token-'+id, user:safeUser });
});

app.get('/api/reviews/', (req,res)=>{
  const r = readJSON('reviews.json', []);
  res.json(r.filter(x=>x.status==='approved'));
});

app.put('/api/orders/:order_id/status', validateAdminOrApiKey, (req,res)=>{
  const orders = readJSON('orders.json', []);
  const id = Number(req.params.order_id);
  const order = orders.find(x=>x.id===id);
  if(!order) return res.status(404).json({detail:'Order not found'});
  order.status = req.body.status || order.status;
  writeJSON('orders.json', orders);
  res.json(order);
});

app.get('/api/reservations/', validateAdminOrApiKey, (req,res)=>{
  const rs = readJSON('reservations.json', []);
  res.json(rs);
});

app.put('/api/reservations/:id/status', validateAdminOrApiKey, (req,res)=>{
  const rs = readJSON('reservations.json', []);
  const id = Number(req.params.id);
  const reservation = rs.find(x=>x.id===id);
  if(!reservation) return res.status(404).json({detail:'Reservation not found'});
  reservation.status = req.body.status || reservation.status;
  writeJSON('reservations.json', rs);
  res.json(reservation);
});

const ALL_TIMES = ['15:00','15:30','16:00','16:30','17:00','17:30','18:00','18:30','19:00','19:30','20:00','20:30','21:00'];
app.get('/api/reservations/available-times', (req,res)=>{
  const { date } = req.query;
  if(!date) return res.status(400).json({detail:'Date is required'});
  const reservations = readJSON('reservations.json', []);
  const reserved = reservations.filter(r=>r.date===date).map(r=>r.time);
  const times = ALL_TIMES.filter(t=>!reserved.includes(t));
  res.json({ times });
});

 app.get('/api/admin/dashboard', (req,res)=>{
  const orders = readJSON('orders.json', []);
  const reservations = readJSON('reservations.json', []);
  const reviews = readJSON('reviews.json', []);
  const menuItems = readJSON('menu.json', []);

  // Optional date range filtering: expect YYYY-MM-DD
  const { start_date, end_date } = req.query;
  const startDate = start_date ? new Date(start_date + 'T00:00:00') : null;
  const endDate = end_date ? new Date(end_date + 'T23:59:59') : null;

  const dash = computeDashboardFromOrders(orders, menuItems, { startDate, endDate });

  const now = new Date();
  const todayStr = now.toISOString().slice(0,10);
  const today_orders = orders.filter(o=>o.created_at && o.created_at.slice(0,10)===todayStr && (!startDate || new Date(o.created_at) >= startDate) && (!endDate || new Date(o.created_at) <= endDate)).length;
  const today_revenue = orders.reduce((sum,o)=>{
    if(!o.created_at) return sum;
    const dstr = o.created_at.slice(0,10);
    if(dstr!==todayStr) return sum;
    const d = new Date(o.created_at);
    if(startDate && d < startDate) return sum;
    if(endDate && d > endDate) return sum;
    return sum + (Number(o.total) || 0);
  }, 0);

  const pending_reservations = reservations.filter(r=>r.status==='pending').length;
  const pending_reviews = reviews.filter(r=>r.status==='pending').length;
  const total_customers = orders.length;

  res.json(Object.assign({}, dash, { total_customers, pending_reservations, pending_reviews, today_orders, today_revenue }));
});

// Refresh dashboard cache on-demand
app.post('/api/admin/dashboard/refresh', (req,res)=>{
  try{
    const orders = readJSON('orders.json', []);
    const menuItems = readJSON('menu.json', []);
    const data = computeDashboardFromOrders(orders, menuItems, {});
    const payload = { generated_at: new Date().toISOString(), data };
    writeJSON('dashboard-cache.json', payload);
    res.json(payload);
  } catch(e){ res.status(500).json({ detail: 'Failed to refresh' }); }
});

app.get('/api/admin/dashboard/cache', (req,res)=>{
  const c = readJSON('dashboard-cache.json', null);
  if(!c) return res.status(404).json({detail:'No dashboard cache available'});
  res.json(c);
});

app.get('/api/menu/items/:id', (req,res)=>{
  const items = readJSON('menu.json', []);
  const item = items.find(x=>x.id===Number(req.params.id));
  if(!item) return res.status(404).json({detail:'Item not found'});
  res.json(item);
});

app.post('/api/menu/items', upload.single('image'), (req,res)=>{
  const items = readJSON('menu.json', []);
  const id = (items.length?items[items.length-1].id:0)+1;
  const record = Object.assign({id}, normalizeMenuPayload(req.body, req.file));
  items.push(record); writeJSON('menu.json', items);
  res.json(record);
});

app.put('/api/menu/items/:id', upload.single('image'), (req,res)=>{
  const items = readJSON('menu.json', []);
  const item = items.find(x=>x.id===Number(req.params.id));
  if(!item) return res.status(404).json({detail:'Item not found'});
  Object.assign(item, normalizeMenuPayload(req.body, req.file));
  writeJSON('menu.json', items);
  res.json(item);
});

app.delete('/api/menu/items/:id', (req,res)=>{
  let items = readJSON('menu.json', []);
  const id = Number(req.params.id);
  if(!items.some(x=>x.id===id)) return res.status(404).json({detail:'Item not found'});
  items = items.filter(x=>x.id!==id);
  writeJSON('menu.json', items);
  res.json({ok:true});
});

// Admin: Create API key
app.post('/api/admin/api-keys', (req,res)=>{
  const { name } = req.body;
  if(!name) return res.status(400).json({ detail: 'API key name required' });
  
  const settings = Object.assign({}, sampleSettings, readJSON('settings.json', sampleSettings));
  const apiKey = 'sk_' + Date.now() + '_' + Math.random().toString(36).substring(7);
  
  if(!settings.api_keys) settings.api_keys = {};
  settings.api_keys[apiKey] = {
    name,
    active: true,
    created_at: new Date().toISOString()
  };
  
  writeJSON('settings.json', settings);
  res.json({ api_key: apiKey, name, active: true });
});

// Admin: List API keys
app.get('/api/admin/api-keys', (req,res)=>{
  const settings = readJSON('settings.json', sampleSettings);
  const keys = settings.api_keys || {};
  
  // Return masked keys
  const masked = Object.entries(keys).map(([key, info]) => ({
    key: key.substring(0, 7) + '...',
    ...info
  }));
  
  res.json(masked);
});

// Admin: Deactivate API key
app.put('/api/admin/api-keys/:api_key/deactivate', (req,res)=>{
  const settings = Object.assign({}, sampleSettings, readJSON('settings.json', sampleSettings));
  const keyPrefix = req.params.api_key;
  const key = Object.keys(settings.api_keys || {}).find(k => k.startsWith(keyPrefix));
  
  if(!key || !settings.api_keys[key]) {
    return res.status(404).json({ detail: 'API key not found' });
  }
  
  settings.api_keys[key].active = false;
  writeJSON('settings.json', settings);
  res.json({ message: 'API key deactivated' });
});

// NEWS ENDPOINTS
app.get('/api/news', (req,res)=>{
  const news = readJSON('news.json', []);
  // Sort by date descending (newest first), highlights first
  const sorted = news.sort((a,b)=>{
    if(a.highlight !== b.highlight) return b.highlight ? 1 : -1;
    return new Date(b.date || b.created_at) - new Date(a.date || a.created_at);
  });
  res.json(sorted);
});

app.get('/api/news/:id', (req,res)=>{
  const news = readJSON('news.json', []);
  const item = news.find(x=>x.id===Number(req.params.id));
  if(!item) return res.status(404).json({detail:'News not found'});
  res.json(item);
});

app.post('/api/news', validateAdminOrApiKey, upload.single('image'), (req,res)=>{
  const news = readJSON('news.json', []);
  const id = (news.length ? news[news.length-1].id : 0) + 1;
  const record = {
    id,
    title: req.body.title || 'Untitled',
    description: req.body.description || '',
    category: req.body.category || 'event',
    date: req.body.date || new Date().toISOString().split('T')[0],
    highlight: req.body.highlight === 'true' || req.body.highlight === true,
    image: req.file ? '/uploads/' + req.file.filename : req.body.image || null,
    created_at: new Date().toISOString()
  };
  news.push(record);
  writeJSON('news.json', news);
  res.json(record);
});

app.put('/api/news/:id', validateAdminOrApiKey, upload.single('image'), (req,res)=>{
  const news = readJSON('news.json', []);
  const item = news.find(x=>x.id===Number(req.params.id));
  if(!item) return res.status(404).json({detail:'News not found'});
  
  if(req.body.title !== undefined) item.title = req.body.title;
  if(req.body.description !== undefined) item.description = req.body.description;
  if(req.body.category !== undefined) item.category = req.body.category;
  if(req.body.date !== undefined) item.date = req.body.date;
  if(req.body.highlight !== undefined) item.highlight = req.body.highlight === 'true' || req.body.highlight === true;
  if(req.file) item.image = '/uploads/' + req.file.filename;
  else if(req.body.image !== undefined) item.image = req.body.image;
  
  writeJSON('news.json', news);
  res.json(item);
});

app.delete('/api/news/:id', validateAdminOrApiKey, (req,res)=>{
  let news = readJSON('news.json', []);
  const id = Number(req.params.id);
  if(!news.some(x=>x.id===id)) return res.status(404).json({detail:'News not found'});
  news = news.filter(x=>x.id!==id);
  writeJSON('news.json', news);
  res.json({ok:true});
});

// small health
app.get('/api/', (req,res)=> res.json({ok:true}));

const port = Number(process.env.PORT) || 3000;
// Schedule daily dashboard cache refresh at midnight server local time
function scheduleDailyDashboardRefresh(){
  const runRefresh = ()=>{
    try{
      const orders = readJSON('orders.json', []);
      const menuItems = readJSON('menu.json', []);
      const data = computeDashboardFromOrders(orders, menuItems, {});
      const payload = { generated_at: new Date().toISOString(), data };
      writeJSON('dashboard-cache.json', payload);
      console.log('Dashboard cache refreshed at', payload.generated_at);
    } catch(e){ console.error('Dashboard refresh failed', e); }
  };
  // run once now
  runRefresh();
  const now = new Date();
  const next = new Date(now);
  next.setHours(24,0,5,0); // shortly after midnight
  const msUntil = next - now;
  setTimeout(()=>{
    runRefresh();
    setInterval(runRefresh, 24*60*60*1000);
  }, msUntil);
}

scheduleDailyDashboardRefresh();

app.listen(port, '0.0.0.0', ()=> console.log('Server started on', port));
