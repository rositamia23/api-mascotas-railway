const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Desactivar caché para evitar datos obsoletos
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// 🛠️ CONFIGURACIÓN NATIVA PARA RAILWAY.APP
// Railway inyecta automáticamente MYSQL_URL o las variables individuales
const poolConfig = process.env.MYSQL_URL 
  ? process.env.MYSQL_URL 
  : {
      host: process.env.MYSQLHOST || 'localhost',
      user: process.env.MYSQLUSER || 'root',
      password: process.env.MYSQLPASSWORD || '',
      database: process.env.MYSQLDATABASE || 'railway',
      port: parseInt(process.env.MYSQLPORT || '3306'),
      waitForConnections: true,
      connectionLimit: 5, // Railway soporta más tráfico, subimos el límite
      queueLimit: 0,
      idleTimeout: 10000
    };

const pool = mysql.createPool(poolConfig);

function handleErr(res, e) {
  console.error(e);
  res.status(500).json({ error: e.message });
}

// 📸 FUNCIÓN MULTIMEDIA NATIVA: Guarda el Base64 limpio directo a MySQL
async function procesarYSubirImagen(inputImagen) {
  if (!inputImagen || typeof inputImagen !== 'string' || inputImagen.trim() === '') return '';
  
  if (inputImagen.startsWith('http://') || inputImagen.startsWith('https://')) {
    return inputImagen;
  }
  
  // Limpiamos la cadena para que no rompa la base de datos
  let stringBase64 = inputImagen.replace(/\s+/g, ''); 
  if (!stringBase64.startsWith('data:')) {
    stringBase64 = `data:image/jpeg;base64,${stringBase64}`;
  }
  
  return stringBase64; 
}

// 👇 FUNCIÓN MAESTRA DE AUDITORÍA 👇
async function registrarMovimiento(usuario_id, usuario_email, accion, entidad, entidad_id, detalle) {
  try {
    const sql = `INSERT INTO movimientos_usuarios 
      (usuario_id, usuario_email, accion, entidad, entidad_id, detalle, fecha_movimiento) 
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`;
    await pool.query(sql, [usuario_id || null, usuario_email || null, accion, entidad, entidad_id || null, detalle || '']);
    console.log(`📝 Movimiento Auditado -> Acción: ${accion} | Entidad: ${entidad}`);
  } catch (e) {
    console.error("❌ Error interno al registrar movimiento en la tabla de auditoría:", e.message);
  }
}

// ==========================================
// ENDPOINTS DE AUTENTICACIÓN
// ==========================================
app.post('/api/register', async (req, res) => {
  try {
    const { nombre, username, celular, email, dni, foto_dni, password } = req.body;
    const base64Dni = await procesarYSubirImagen(foto_dni);
    
    const sql = `INSERT INTO usuarios 
      (nombre_completo, username, correo, clave, celular, dni, foto_dni, rol) 
      VALUES (?, ?, ?, ?, ?, ?, ?, "usuario")`;

    const [r] = await pool.query(sql, [nombre, username, email, password, celular, dni, base64Dni]);
    
    await registrarMovimiento(r.insertId, email, 'REGISTRO', 'usuarios', r.insertId, `Nuevo usuario registrado: ${username}`);
    res.status(201).json({ message: 'Ok', usuario_id: r.insertId });
  } catch (e) { handleErr(res, e); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password, clave } = req.body;
    const incomingPassword = password || clave; 

    const [rows] = await pool.query('SELECT * FROM usuarios WHERE correo=? OR username=?', [email, email]);
    if (rows.length === 0) return res.status(401).json({ error: 'Invalido' });

    const u = rows[0];
    if (String(u.clave).trim() !== String(incomingPassword).trim()) return res.status(401).json({ error: 'Invalido' });

    await pool.query('UPDATE usuarios SET ultimo_movimiento = CURRENT_TIMESTAMP WHERE usuario_id = ?', [u.usuario_id]);
    await registrarMovimiento(u.usuario_id, u.correo, 'LOGIN', 'usuarios', u.usuario_id, `Inicio de sesión exitoso desde app móvil`);
    res.json({ id: u.usuario_id, nombre: u.nombre_completo, email: u.correo, rol: u.rol, celular: u.celular, dni: u.dni });
  } catch (e) { handleErr(res, e); }
});

// ==========================================
// ENDPOINTS: MASCOTAS EN ADOPCION
// ==========================================
app.get('/api/adopciones', async (req, res) => {
  try {
    const [r] = await pool.query("SELECT * FROM mascotas_adopcion WHERE COALESCE(estado, 'activo')='activo' ORDER BY mascota_id DESC");
    res.json(r);
  } catch (e) { handleErr(res, e); }
});

app.post('/api/adopciones', async (req, res) => {
  try {
    const { usuario_id, nombre, etapa, raza, ubicacion, latitud, longitud, notas, imagen, usuario_email, celular_contacto } = req.body;
    const fixedUid = usuario_id || 1;
    const fixedLat = latitud || -7.7447;
    const fixedLon = longitud || -79.1822;

    const base64Img = await procesarYSubirImagen(imagen);

    const [r] = await pool.query(
      'INSERT INTO mascotas_adopcion (usuario_id, nombre, etapa, raza, ubicacion, latitud, longitud, notas, imagen, usuario_email, fecha_publicacion, estado, celular_contacto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), "activo", ?)', 
      [fixedUid, nombre, etapa, raza, ubicacion, fixedLat, fixedLon, notas, base64Img, usuario_email, celular_contacto]
    );
    
    await registrarMovimiento(fixedUid, usuario_email, 'CREAR', 'mascotas_adopcion', r.insertId, `Publicó a ${nombre} en adopción`);
    res.status(201).json({ message: 'Ok', mascota_id: r.insertId });
  } catch (e) { handleErr(res, e); }
});

app.put('/api/adopciones/:id', async (req, res) => {
  try {
    const { nombre, etapa, raza, ubicacion, latitud, longitud, notas, imagen, celular_contacto, usuario_id, usuario_email } = req.body;
    const base64Img = await procesarYSubirImagen(imagen);
    
    await pool.query('UPDATE mascotas_adopcion SET nombre=?, etapa=?, raza=?, ubicacion=?, latitud=?, longitud=?, notas=?, imagen=?, celular_contacto=? WHERE mascota_id=?', [nombre, etapa, raza, ubicacion, latitud, longitud, notas, base64Img, celular_contacto, req.params.id]);
    
    await registrarMovimiento(usuario_id, usuario_email, 'EDITAR', 'mascotas_adopcion', req.params.id, `Modificó los datos de la mascota id: ${req.params.id}`);
    res.json({ message: 'Ok' });
  } catch (e) { handleErr(res, e); }
});

app.delete('/api/adopciones/:id', async (req, res) => {
  try {
    const { usuario_id, usuario_email } = req.body;
    await pool.query("UPDATE mascotas_adopcion SET estado='inactivo' WHERE mascota_id=?", [req.params.id]);
    
    await registrarMovimiento(usuario_id, usuario_email, 'ELIMINAR', 'mascotas_adopcion', req.params.id, `Puso en estado inactivo la adopción id: ${req.params.id}`);
    res.json({ message: 'Ok' });
  } catch (e) { handleErr(res, e); }
});

// ==========================================
// ENDPOINTS: MASCOTAS PERDIDAS
// ==========================================
app.get('/api/perdidos', async (req, res) => {
  try {
    const [r] = await pool.query("SELECT * FROM mascotas_perdidas WHERE COALESCE(estado, 'activo')='activo' ORDER BY alerta_id DESC");
    res.json(r);
  } catch (e) { handleErr(res, e); }
});

app.post('/api/perdidos', async (req, res) => {
  try {
    const { usuario_id, nombre, raza, celular, dueno, fecha_extravio, ubicacion, notas, latitud, longitud, imagen, usuario_email, recompensa } = req.body;
    const fixedUid = usuario_id || 1;
    const fixedLat = latitud || -7.7447;
    const fixedLon = longitud || -79.1822;

    const base64Img = await procesarYSubirImagen(imagen);

    const [r] = await pool.query(
      'INSERT INTO mascotas_perdidas (usuario_id, nombre, raza, celular, dueno, fecha_extravio, ubicacion, notas, latitud, longitud, imagen, usuario_email, recompensa, fecha_publicacion, estado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), "activo")', 
      [fixedUid, nombre, raza, celular, dueno, fecha_extravio, ubicacion, notas, fixedLat, fixedLon, base64Img, usuario_email, recompensa]
    );
    
    await registrarMovimiento(fixedUid, usuario_email, 'CREAR', 'mascotas_perdidas', r.insertId, `Creó alerta de extravio de ${nombre}`);
    res.status(201).json({ message: 'Ok', alerta_id: r.insertId });
  } catch (e) { handleErr(res, e); }
});

app.put('/api/perdidos/:id', async (req, res) => {
  try {
    const { nombre, raza, celular, dueno, ubicacion, notas, latitud, longitud, imagen, recompensa, usuario_id, usuario_email } = req.body;
    const base64Img = await procesarYSubirImagen(imagen);
    
    await pool.query('UPDATE mascotas_perdidas SET nombre=?, raza=?, celular=?, dueno=?, ubicacion=?, notas=?, latitud=?, longitud=?, imagen=?, recompensa=? WHERE alerta_id=?', [nombre, raza, celular, dueno, ubicacion, notas, latitud, longitud, base64Img, recompensa, req.params.id]);
    
    await registrarMovimiento(usuario_id, usuario_email, 'EDITAR', 'mascotas_perdidas', req.params.id, `Actualizó alerta de extravio id: ${req.params.id}`);
    res.json({ message: 'Ok' });
  } catch (e) { handleErr(res, e); }
});

app.delete('/api/perdidos/:id', async (req, res) => {
  try {
    const { usuario_id, usuario_email } = req.body;
    await pool.query("UPDATE mascotas_perdidas SET estado='inactivo' WHERE alerta_id=?", [req.params.id]);
    
    await registrarMovimiento(usuario_id, usuario_email, 'ELIMINAR', 'mascotas_perdidas', req.params.id, `Desactivó alerta de extravio id: ${req.params.id}`);
    res.json({ message: 'Ok' });
  } catch (e) { handleErr(res, e); }
});

// ==========================================
// ENDPOINTS: REGISTRO DE RESCATES
// ==========================================
app.get('/api/rescates', async (req, res) => {
  try {
    const [r] = await pool.query("SELECT * FROM registro_rescates ORDER BY ficha_id DESC");
    res.json(r);
  } catch (e) { handleErr(res, e); }
});

app.post('/api/rescates', async (req, res) => {
  try {
    const { usuario_id, nombre, especie, estado_clinico, ubicacion, notes, notas, latitud, longitud, imagen, usuario_email, celular_contacto } = req.body;
    const fixedUid = usuario_id || 1;
    const fixedLat = latitud || -7.7447;
    const fixedLon = longitud || -79.1822;
    const textoNotas = notas || notes || '';

    const base64Img = await procesarYSubirImagen(imagen);

    const [r] = await pool.query(
      'INSERT INTO registro_rescates (usuario_id, nombre, especie, estado_clinico, ubicacion, notas, latitud, longitud, imagen, usuario_email, celular_contacto, fecha_publicacion) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE())', 
      [fixedUid, nombre, especie, estado_clinico, ubicacion, textoNotas, fixedLat, fixedLon, base64Img, usuario_email, celular_contacto]
    );
    
    await registrarMovimiento(fixedUid, usuario_email, 'CREAR', 'registro_rescates', r.insertId, `Reportó caso de emergencia médica para ${nombre}`);
    res.status(201).json({ message: 'Ok', ficha_id: r.insertId });
  } catch (e) { handleErr(res, e); }
});

app.put('/api/rescates/:id', async (req, res) => {
  try {
    const { nombre, especie, estado_clinico, ubicacion, notes, notas, latitud, longitud, imagen, celular_contacto, usuario_id, usuario_email } = req.body;
    const base64Img = await procesarYSubirImagen(imagen);
    const textoNotas = notas || notes || '';
    
    await pool.query(
      'UPDATE registro_rescates SET nombre=?, especie=?, estado_clinico=?, ubicacion=?, notas=?, latitud=?, longitud=?, imagen=?, celular_contacto=? WHERE ficha_id=?', 
      [nombre, especie, estado_clinico, ubicacion, textoNotas, latitud, longitud, base64Img, celular_contacto, req.params.id]
    );
    
    await registrarMovimiento(usuario_id, usuario_email, 'EDITAR', 'registro_rescates', req.params.id, `Modificó caso clínico id: ${req.params.id}`);
    res.json({ message: 'Ok' });
  } catch (e) { handleErr(res, e); }
});

app.delete('/api/rescates/:id', async (req, res) => {
  try {
    const { usuario_id, usuario_email } = req.body;
    let uid = usuario_id || 1;
    let email = usuario_email || 'admin@mascotas.com';

    await pool.query("DELETE FROM registro_rescates WHERE ficha_id=?", [req.params.id]);
    
    await registrarMovimiento(uid, email, 'ELIMINAR', 'registro_rescates', req.params.id, `Eliminó el caso clínico id: ${req.params.id}`);
    res.json({ message: 'Ok' });
  } catch (e) { handleErr(res, e); }
});

// ==========================================
// ENDPOINTS: SOLICITUDES DE ADOPCION
// ==========================================
app.get('/api/solicitudes', async (req, res) => {
  try {
    const [r] = await pool.query("SELECT * FROM solicitudes_adopcion ORDER BY solicitud_id DESC");
    res.json(r);
  } catch (e) { handleErr(res, e); }
});

app.post('/api/solicitudes', async (req, res) => {
  try {
    let { mascota_id, nombre_mascota, usuario_solicitante, correo_solicitante, telefono_solicitante, nombre_solicitante, dni_solicitante, numero_solicitante, vivienda, experiencia, estado, usuario_id } = req.body;
    let fixedMascotaId = mascota_id || req.body.id_mascota;
    
    if (!fixedMascotaId || isNaN(fixedMascotaId)) {
      const [existentes] = await pool.query("SELECT mascota_id FROM mascotas_adopcion LIMIT 1");
      if (existentes.length > 0) fixedMascotaId = existentes[0].mascota_id;
      else return res.status(400).json({ error: 'Falta vincular mascota_id relacional.' });
    }

    const sql = `INSERT INTO solicitudes_adopcion (mascota_id, nombre_mascota, usuario_solicitante, correo_solicitante, telefono_solicitante, nombre_solicitante, dni_solicitante, numero_solicitante, vivienda, experiencia, estado, fecha_solicitud, usuario_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), ?)`;
    const [r] = await pool.query(sql, [fixedMascotaId, nombre_mascota || 'Mascota', usuario_solicitante || 'Anónimo', correo_solicitante || 'correo@test.com', telefono_solicitante || '987654321', nombre_solicitante || '', dni_solicitante || '', numero_solicitante || '', vivienda || '', experiencia || '', estado || 'pendiente', usuario_id || null]);
    
    await registrarMovimiento(usuario_id, correo_solicitante, 'CREAR', 'solicitudes_adopcion', r.insertId, `Envió un formulario de adopción para la mascota ID: ${fixedMascotaId}`);
    res.status(201).json({ message: 'Ok' });
  } catch (e) { handleErr(res, e); }
});

// ==========================================
// ENDPOINTS: APOYOS BENÉFICOS
// ==========================================
app.get('/api/apoyos', async (req, res) => {
  try {
    let q = "SELECT * FROM apoyo_beneficio WHERE COALESCE(estado, 'activo')='activo'";
    let params = [];
    let rolLimpio = (req.query.usuario_rol || req.query.rol || '').toLowerCase().trim();
    let emailLimpio = (req.query.usuario_email || req.query.email || '').toLowerCase().trim();
    const staff = ['administrador', 'admin', 'supervisor'];

    if (staff.includes(rolLimpio) || emailLimpio.includes('admin') || emailLimpio === 'coordinador@mascotas-unidas.org') {
      // Personal ve todo
    } else {
      q += " AND (estado_revision='aprobado'";
      if (emailLimpio.length > 0) {
        q += " OR (estado_revision='pendiente' AND correo_solicitante=?))";
        params.push(emailLimpio);
      } else { q += ")"; }
    }
    const [r] = await pool.query(q + ' ORDER BY donacion_id DESC', params);
    res.json(r);
  } catch (e) { handleErr(res, e); }
});

app.get('/api/apoyos/denuncias/:id', async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM denuncias_apoyo WHERE apoyo_id = ? ORDER BY denuncia_id DESC", [req.params.id]);
    res.json(rows);
  } catch (e) { handleErr(res, e); }
});

app.post('/api/apoyos', async (req, res) => {
  try {
    const userId = req.body.usuario_id || 0;
    const metaRecaudacion = parseFloat(req.body.meta_recaudacion) || 0.00;
    const metaAdd = req.body.monto_meta || '';
    const objEsp = req.body.monto_objetivo || '';
    const linkRedes = req.body.enlace_redes || '';
    const typeDoc = req.body.tipo_documento_respaldo || '';
    const driveDoc = req.body.enlace_documento || '';
    const emailSol = req.body.correo_solicitante || req.body.usuario_email || '';
    
    // Todo en Base64 nativo
    const bMascota = await procesarYSubirImagen(req.body.imagen_mascota);
    const bDocRespaldo = await procesarYSubirImagen(req.body.documento_respaldo);
    const bCompGasto = await procesarYSubirImagen(req.body.comprobantes_gasto || req.body.documento_respaldo);
    const bFotoDni = await procesarYSubirImagen(req.body.foto_dni);
    const bGeneral = await procesarYSubirImagen(req.body.imagen || req.body.imagen_mascota);
    const bEviRescatista = await procesarYSubirImagen(req.body.evidencia_rescatista);
    const bCompUso = await procesarYSubirImagen(req.body.comprobantes_uso);
    
    const sql = `INSERT INTO apoyo_beneficio 
      (usuario_id, nombre_solicitante, dni_solicitante, correo_solicitante, telefono_solicitante, 
       motivo_ayuda, historia, meta_recaudacion, monto_recaudado, ubicacion, 
       latitud, longitud, imagen_mascota, documento_respaldo, comprobantes_gasto, 
       estado_revision, motivo_rechazo, denuncias_count, foto_dni, titulo, 
       descripcion, nombre_mascota, tipo_apoyo, numero_contacto, contacto, 
       imagen, fotos_mascota, tipo_documento_respaldo, evidencia_rescatista, enlace_redes, 
       monto_meta, monto_objetivo, comprobantes_uso, actualizaciones, estado, 
       usuario_email, fecha_publicacion, enlace_documento) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'activo', ?, CURDATE(), ?)`;
      
    const values = [
      userId, req.body.nombre_solicitante || '', req.body.dni_solicitante || '', emailSol, req.body.telefono_solicitante || '', req.body.motivo_ayuda || '', req.body.historia || '',
      metaRecaudacion, parseFloat(req.body.monto_recaudado) || 0.00, req.body.ubicacion || 'Casa Grande, Ascope', parseFloat(req.body.latitud) || -7.7447, parseFloat(req.body.longitud) || -79.1822,
      bMascota, bDocRespaldo, bCompGasto, req.body.estado_revision || 'pendiente', bFotoDni, req.body.titulo || 'Campaña', req.body.descripcion || req.body.historia || '',
      req.body.nombre_mascota || 'Mascota', req.body.tipo_apoyo || 'DINERO', req.body.numero_contacto || '', req.body.contacto || '', bGeneral, bMascota,
      typeDoc, bEviRescatista, linkRedes, metaAdd, objEsp, bCompUso, emailSol, driveDoc
    ];
    
    const [r] = await pool.query(sql, values);
    await registrarMovimiento(userId, emailSol, 'CREAR', 'apoyo_beneficio', r.insertId, `Registró campaña: ${req.body.titulo}`);
    res.status(201).json({ message: 'Ok' });
  } catch (e) { handleErr(res, e); }
});

app.put('/api/apoyos/revision/:id', async (req, res) => {
  try {
    await pool.query('UPDATE apoyo_beneficio SET estado_revision=?, motivo_rechazo=?, actualizaciones=? WHERE donacion_id=?', [req.body.estado_revision, req.body.motivo_rechazo || null, req.body.actualizaciones || null, req.params.id]);
    await registrarMovimiento(1, 'admin@mascotas.com', 'REVISIÓN', 'apoyo_beneficio', req.params.id, `Cambió estado de revisión de la campaña a: ${req.body.estado_revision}`);
    res.json({ message: 'Ok' });
  } catch (e) { handleErr(res, e); }
});

app.delete('/api/apoyos/:id', async (req, res) => {
  try {
    await pool.query("UPDATE apoyo_beneficio SET estado='inactivo' WHERE donacion_id=?", [req.params.id]);
    res.json({ message: 'Ok' });
  } catch (e) { handleErr(res, e); }
});

// ==========================================
// 📊 DASHBOARD GENERAL (Sincronizado)
// ==========================================
app.get('/api/dashboard', async (req, res) => {
  try {
    const [[adop]] = await pool.query("SELECT COUNT(*) as c FROM mascotas_adopcion WHERE COALESCE(estado, 'activo')='activo'");
    const [[perd]] = await pool.query("SELECT COUNT(*) as c FROM mascotas_perdidas WHERE COALESCE(estado, 'activo')='activo'");
    const [[resc]] = await pool.query("SELECT COUNT(*) as c FROM registro_rescates");
    const [[apoy]] = await pool.query("SELECT COUNT(*) as c FROM apoyo_beneficio WHERE COALESCE(estado, 'activo')='activo' AND estado_revision='aprobado'");

    const totalSincronizado = adop.c + perd.c + resc.c + apoy.c;
    res.json({ total_mascotas: totalSincronizado, en_adopcion: adop.c, alertas_activas: perd.c, casos_exitosos: resc.c });
  } catch (e) { handleErr(res, e); }
});

// ==========================================
// 🗺️ MAPA GLOBAL INTEGRADO
// ==========================================
app.get('/api/mapa-global', async (req, res) => {
  try {
    const sql = `
      SELECT mascota_id as id, nombre, 'adopcion' as tipo, notas, ubicacion, COALESCE(latitud, -7.7447) as latitud, COALESCE(longitud, -79.1822) as longitud, imagen, celular_contacto as contacto FROM mascotas_adopcion WHERE COALESCE(estado, 'activo')='activo'
      UNION ALL 
      SELECT alerta_id as id, nombre, 'perdido' as tipo, notas, ubicacion, COALESCE(latitud, -7.7447) as latitud, COALESCE(longitud, -79.1822) as longitud, imagen, celular as contacto FROM mascotas_perdidas WHERE COALESCE(estado, 'activo')='activo'
      UNION ALL 
      SELECT ficha_id as id, nombre, 'rescate' as tipo, notas, ubicacion, COALESCE(latitud, -7.7447) as latitud, COALESCE(longitud, -79.1822) as longitud, imagen, celular_contacto as contacto FROM registro_rescates
      UNION ALL
      SELECT donacion_id as id, titulo as nombre, 'apoyo' as tipo, historia as notas, ubicacion, COALESCE(latitud, -7.7447) as latitud, COALESCE(longitud, -79.1822) as longitud, imagen_mascota as imagen, numero_contacto as contacto FROM apoyo_beneficio WHERE COALESCE(estado, 'activo')='activo' AND estado_revision='aprobado'`;
    const [rows] = await pool.query(sql);
    res.json(rows);
  } catch (e) { handleErr(res, e); }
});

// ==========================================
// 🔔 NOTIFICACIONES CON RECHAZOS
// ==========================================
app.get('/api/notificaciones', async (req, res) => {
  try {
    const emailLimpio = (req.query.email || req.query.usuario_email || '').toLowerCase().trim();
    let queryRechazados = "";

    if (emailLimpio.length > 0) {
      queryRechazados = `
        UNION ALL
        SELECT 'rechazado' as tipo, 'Campaña Rechazada' as titulo, CONCAT('Tu solicitud "', titulo, '" fue rechazada. Motivo: ', COALESCE(motivo_rechazo, 'No cumple los requisitos')) as subtitulo, actualizado_en as orden 
        FROM apoyo_beneficio 
        WHERE estado_revision='rechazado' AND correo_solicitante = ${pool.escape(emailLimpio)}
      `;
    }

    const sql = `
      SELECT 'solicitud' as tipo, 'Trámite Adopción' as titulo, CONCAT(usuario_solicitante, ' solicitó adoptar a ', nombre_mascota, '. Contacto: ', telefono_solicitante) as subtitulo, fecha_solicitud as orden FROM solicitudes_adopcion
      UNION ALL 
      SELECT 'adopcion' as tipo, 'Nueva Adopción' as titulo, CONCAT('Disponible: ', nombre, ' (Raza: ', raza, ', Etapa: ', etapa, ') en ', ubicacion) as subtitulo, fecha_publicacion as orden FROM mascotas_adopcion WHERE estado='activo'
      UNION ALL 
      SELECT 'perdido' as tipo, 'Alerta Roja' as titulo, CONCAT('🚨 ¡Mascota extraviada!: ', nombre, ' (', raza, ') visto en ', ubicacion) as subtitulo, fecha_publicacion as orden FROM mascotas_perdidas WHERE estado='activo'
      ${queryRechazados}
      ORDER BY orden DESC LIMIT 15`;
      
    const [notificaciones] = await pool.query(sql);
    res.json(notificaciones);
  } catch (e) { handleErr(res, e); }
});

const PORT = process.env.PORT || 3000;
// Inicia el servidor directo sin necesidad de "ensureSchema" porque las tablas ya las creaste manual en Railway
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 API NATIVA ONLINE EN EL PUERTO ${PORT}`));