const path = require('path');
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if(!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(__dirname));

// helpers
function readJSON(name, fallback) {
  const p = path.join(DATA_DIR, name);
  if(!fs.existsSync(p)) { fs.writeFileSync(p, JSON.stringify(fallback || {})); }
  return JSON.parse(fs.readFileSync(p,'utf8'));
}
function writeJSON(name, data) { fs.writeFileSync(path.join(DATA_DIR,name), JSON.stringify(data, null, 2)); }

// sample data
const sampleMenu = [
  {id:1,name:'West Texas Burger',description:'Juicy beef patty',price:13.95,calories:780,category_id:1,is_featured:true,is_popular:true,is_spicy:false,is_available:true,allergens:'gluten, dairy'}
];
const sampleCats = [{id:1,name:'Burgers',icon:'🍔'},{id:2,name:'Cocktails',icon:'🍸'}];
const sampleSettings = { hero_image:null, photo_strip_1:null, photo_strip_2:null, photo_strip_3:null, cocktail_banner_image:null, menu_bg_image:null };

// ensure data files
readJSON('menu.json', sampleMenu);
readJSON('categories.json', sampleCats);
readJSON('settings.json', sampleSettings);
readJSON('orders.json', []);
readJSON('reservations.json', []);
readJSON('reviews.json', []);

// API routes
app.get('/api/menu/items', (req,res)=>{
  const items = readJSON('menu.json', sampleMenu);
  res.json(items);
});
app.get('/api/menu/categories', (req,res)=>{
  const cats = readJSON('categories.json', sampleCats);
  res.json(cats);
});

app.get('/api/settings', (req,res)=>{
  const s = readJSON('settings.json', sampleSettings);
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
  const s = readJSON('settings.json', sampleSettings);
  s[slot] = rel;
  writeJSON('settings.json', s);
  res.json({slot, url: rel});
});

app.get('/api/orders/track/:order_id', (req,res)=>{
  const id = Number(req.params.order_id);
  const orders = readJSON('orders.json', []);
  const o = orders.find(x=>x.id===id);
  if(!o) return res.status(404).json({detail:'Not found'});
  res.json(o);
});

app.post('/api/orders/', (req,res)=>{
  const orders = readJSON('orders.json', []);
  const id = (orders.length?orders[orders.length-1].id:0)+1;
  const record = Object.assign({id, status:'pending', created_at:new Date().toISOString()}, req.body);
  orders.push(record); writeJSON('orders.json', orders);
  res.json(record);
});

app.post('/api/reservations/', (req,res)=>{
  const rs = readJSON('reservations.json', []);
  const id = (rs.length?rs[rs.length-1].id:0)+1;
  const rec = Object.assign({id,status:'pending'}, req.body);
  rs.push(rec); writeJSON('reservations.json', rs);
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
  res.json(rec);
});

// small health
app.get('/api/', (req,res)=> res.json({ok:true}));

const port = process.env.PORT || 3000;
app.listen(port, ()=> console.log('Server started on', port));
