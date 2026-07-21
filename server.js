const express = require('express');
const mysql = require('mysql2/promise');
const cloudinary = require('cloudinary').v2;
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Desactivar caché para evitar datos obsoletos en la aplicación móvil
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// ☁️ Configuración global del cliente de Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// 🟢 Conexión directa y limpia a tu base de datos
const poolConfig = 'mysql://root:EpuMxJLSsSXUZpFxabPihWbbNXwXFOwb@tokaido.proxy.rlwy.net:53838/railway';
const pool = mysql.createPool(poolConfig);

function handleErr(res, e) {
  console.error(e);
  res.status(500).json({ error: e.message });
}

// ☁️ FUNCIÓN MAESTRA MULTIMEDIA
async function procesarYSubirImagen(inputImagen, carpetaDestino = 'mascotas_unidas') {
  if (!inputImagen || typeof inputImagen !== 'string' || inputImagen.trim() === '') return '';
  
  if (inputImagen.startsWith('http://') || inputImagen.startsWith('https://')) {
    return inputImagen;
  }
  
  try {
    let stringBase64 = inputImagen;
    if (!stringBase64.startsWith('data:')) {
      stringBase64 = `data:image/jpeg;base64,${inputImagen}`;
    }
    
    const uploadResponse = await cloudinary.uploader.upload(stringBase64, {
      folder: carpetaDestino
    });
    return uploadResponse.secure_url;
  } catch (e) {
    console.error(`❌ Error al subir imagen a Cloudinary en [${carpetaDestino}]:`, e.message);
    return inputImagen;
  }
}

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

app.post('/api/register', async (req, res) => {
  try {
    const { nombre, username, celular, email, dni, foto_dni, password } = req.body;
    const urlFotoDni = await procesarYSubirImagen(foto_dni, 'usuarios_dni');
    
    const sql = `INSERT INTO usuarios 
      (nombre_completo, username, correo, clave, celular, dni, foto_dni, rol) 
      VALUES (?, ?, ?, ?, ?, ?, ?, "usuario")`;

    const [r] = await pool.query(sql, [nombre, username, email, password, celular, dni, urlFotoDni]);
    
    await registrarMovimiento(r.insertId, email, 'REGISTRO', 'usuarios', r.insertId, `Nuevo usuario registrado: ${username}`);
    res.status(201).json({ message: 'Ok', usuario_id: r.insertId });
  } catch (e) { handleErr(res, e); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password, clave } = req.body;
    const incomingPassword = password || clave; 

    const [rows] = await pool.query('SELECT * FROM usuarios WHERE correo=? OR username=?', [email, email]);
    
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalido' });
    }

    const u = rows[0];

    if (String(u.clave).trim() !== String(incomingPassword).trim()) {
      return res.status(401).json({ error: 'Invalido' });
    }

    if (u.estado_verificacion === 'rechazado') {
      return res.status(403).json({ 
        error: 'RECHAZADO', 
        message: 'Revisen que estén bien sus datos y número de DNI para que se vuelvan a registrar.' 
      });
    }

    await pool.query('UPDATE usuarios SET ultimo_movimiento = CURRENT_TIMESTAMP WHERE usuario_id = ?', [u.usuario_id]);
    
    await registrarMovimiento(u.usuario_id, u.correo, 'LOGIN', 'usuarios', u.usuario_id, `Inicio de sesión exitoso desde app móvil`);
    res.json({ id: u.usuario_id, nombre: u.nombre_completo, email: u.correo, rol: u.rol, celular: u.celular, dni: u.dni });
  } catch (e) { handleErr(res, e); }
});

// 🟢 CORREGIDO: Endpoint Adopciones ahora recibe y aplica el filtro de fecha_publicacion
app.get('/api/adopciones', async (req, res) => {
  try {
    const { fecha_publicacion } = req.query;
    let query = "SELECT * FROM mascotas_adopcion WHERE COALESCE(estado, 'activo')='activo'";
    let params = [];

    if (fecha_publicacion) {
      query += " AND fecha_publicacion = ?";
      params.push(fecha_publicacion);
    }

    query += " ORDER BY mascota_id DESC";
    const [r] = await pool.query(query, params);
    res.json(r);
  } catch (e) { handleErr(res, e); }
});

app.post('/api/adopciones', async (req, res) => {
  try {
    const { usuario_id, nombre, etapa, raza, ubicacion, latitud, longitud, notas, imagen, usuario_email, celular_contacto } = req.body;
    const fixedUid = usuario_id || 1;
    const fixedLat = latitud || -8.1119;
    const fixedLon = longitud || -79.0286;

    const urlImagenMascota = await procesarYSubirImagen(imagen, 'mascotas_adopcion');

    const [r] = await pool.query(
      'INSERT INTO mascotas_adopcion (usuario_id, nombre, etapa, raza, ubicacion, latitud, longitud, notas, imagen, usuario_email, fecha_publicacion, estado, celular_contacto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), "activo", ?)', 
      [fixedUid, nombre, etapa, raza, ubicacion, fixedLat, fixedLon, notas, urlImagenMascota, usuario_email, celular_contacto]
    );
    
    await registrarMovimiento(fixedUid, usuario_email, 'CREAR', 'mascotas_adopcion', r.insertId, `Publicó a ${nombre} en adopción`);
    res.status(201).json({ message: 'Ok', mascota_id: r.insertId });
  } catch (e) { handleErr(res, e); }
});

app.put('/api/adopciones/:id', async (req, res) => {
  try {
    const { nombre, etapa, raza, ubicacion, latitud, longitud, notas, imagen, celular_contacto, usuario_id, usuario_email } = req.body;
    const urlImagenMascota = await procesarYSubirImagen(imagen, 'mascotas_adopcion');
    
    await pool.query('UPDATE mascotas_adopcion SET nombre=?, etapa=?, raza=?, ubicacion=?, latitud=?, longitud=?, notas=?, imagen=?, celular_contacto=? WHERE mascota_id=?', [nombre, etapa, raza, ubicacion, latitud, longitud, notas, urlImagenMascota, celular_contacto, req.params.id]);
    
    await registrarMovimiento(usuario_id, usuario_email, 'EDITAR', 'mascotas_adopcion', req.params.id, `Modificó los datos de la mascota id: ${req.params.id}`);
    res.json({ message: 'Ok' });
  } catch (e) { handleErr(res, e); }
});

app.delete('/api/adopciones/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM solicitudes_adopcion WHERE mascota_id = ?', [id]);
    await pool.query('DELETE FROM movimientos_usuarios WHERE entidad_id = ? AND (accion LIKE "%Adopción%" OR entidad = "adopcion")', [id]);
    await pool.query('DELETE FROM mascotas_adopcion WHERE mascota_id = ?', [id]);
    res.json({ message: 'Mascota y notificaciones eliminadas correctamente' });
  } catch (error) { handleErr(res, error); }
});

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
    const fixedLat = latitud || -8.1119;
    const fixedLon = longitud || -79.0286;

    const urlImagenPerdido = await procesarYSubirImagen(imagen, 'mascotas_perdidas');

    const [r] = await pool.query(
      'INSERT INTO mascotas_perdidas (usuario_id, nombre, raza, celular, dueno, fecha_extravio, ubicacion, notas, latitud, longitud, imagen, usuario_email, recompensa, fecha_publicacion, estado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), "activo")', 
      [fixedUid, nombre, raza, celular, dueno, fecha_extravio, ubicacion, notas, fixedLat, fixedLon, urlImagenPerdido, usuario_email, recompensa]
    );
    
    await registrarMovimiento(fixedUid, usuario_email, 'CREAR', 'mascotas_perdidas', r.insertId, `Creó alerta de extravio de ${nombre}`);
    res.status(201).json({ message: 'Ok', alerta_id: r.insertId });
  } catch (e) { handleErr(res, e); }
});

app.put('/api/perdidos/:id', async (req, res) => {
  try {
    const { nombre, raza, celular, dueno, ubicacion, notas, latitud, longitud, imagen, recompensa, usuario_id, usuario_email } = req.body;
    const urlImagenPerdido = await procesarYSubirImagen(imagen, 'mascotas_perdidas');
    
    await pool.query('UPDATE mascotas_perdidas SET nombre=?, raza=?, celular=?, dueno=?, ubicacion=?, notas=?, latitud=?, longitud=?, imagen=?, recompensa=? WHERE alerta_id=?', [nombre, raza, celular, dueno, ubicacion, notas, latitud, longitud, urlImagenPerdido, recompensa, req.params.id]);
    
    await registrarMovimiento(usuario_id, usuario_email, 'EDITAR', 'mascotas_perdidas', req.params.id, `Actualizó alerta de extravio id: ${req.params.id}`);
    res.json({ message: 'Ok' });
  } catch (e) { handleErr(res, e); }
});

app.delete('/api/perdidos/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM movimientos_usuarios WHERE entidad_id = ? AND (accion LIKE "%Alerta%" OR entidad = "perdido")', [id]);
    await pool.query('DELETE FROM mascotas_perdidas WHERE alerta_id = ?', [id]);
    res.json({ message: 'Alerta y notificaciones eliminadas correctamente' });
  } catch (error) { handleErr(res, error); }
});

app.get('/api/rescates', async (req, res) => {
  try {
    const [r] = await pool.query("SELECT * FROM registro_rescates ORDER BY ficha_id DESC");
    res.json(r);
  } catch (e) { handleErr(res, e); }
});

app.post('/api/rescates', async (req, res) => {
  try {
    const { usuario_id, nombre, especie, estado_clinico, ubicacion, notas, latitud, longitud, imagen, usuario_email, celular_contacto } = req.body;
    const fixedUid = usuario_id || 1;
    const fixedLat = latitud || -8.1119;
    const fixedLon = longitud || -79.0286;

    const urlImagenRescate = await procesarYSubirImagen(imagen, 'registro_rescates');

    const [r] = await pool.query(
      'INSERT INTO registro_rescates (usuario_id, nombre, especie, estado_clinico, ubicacion, notas, latitud, longitud, imagen, usuario_email, celular_contacto, fecha_publicacion) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE())', 
      [fixedUid, nombre, especie, estado_clinico, ubicacion, notas, fixedLat, fixedLon, urlImagenRescate, usuario_email, celular_contacto]
    );
    
    await registrarMovimiento(fixedUid, usuario_email, 'CREAR', 'registro_rescates', r.insertId, `Reportó caso de emergencia médica para ${nombre}`);
    res.status(201).json({ message: 'Ok', ficha_id: r.insertId });
  } catch (e) { handleErr(res, e); }
});

app.put('/api/rescates/:id', async (req, res) => {
  try {
    const { nombre, especie, estado_clinico, ubicacion, notas, latitud, longitud, imagen, celular_contacto, usuario_id, usuario_email } = req.body;
    const urlImagenRescate = await procesarYSubirImagen(imagen, 'registro_rescates');
    
    await pool.query(
      'UPDATE registro_rescates SET nombre=?, especie=?, estado_clinico=?, ubicacion=?, notas=?, latitud=?, longitud=?, imagen=?, celular_contacto=? WHERE ficha_id=?', 
      [nombre, especie, estado_clinico, ubicacion, notas, latitud, longitud, urlImagenRescate, celular_contacto, req.params.id]
    );
    
    await registrarMovimiento(usuario_id, usuario_email, 'EDITAR', 'registro_rescates', req.params.id, `Modificó caso clínico id: ${req.params.id}`);
    res.json({ message: 'Ok' });
  } catch (e) { handleErr(res, e); }
});

app.delete('/api/rescates/:id', async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT usuario_id, usuario_email FROM registro_rescates WHERE ficha_id=?", [req.params.id]);
    let uid = 1, email = 'admin@mascotas.com';
    if(rows.length > 0) { uid = rows[0].usuario_id; email = rows[0].usuario_email; }

    await pool.query("DELETE FROM registro_rescates WHERE ficha_id=?", [req.params.id]);
    await registrarMovimiento(uid, email, 'ELIMINAR', 'registro_rescates', req.params.id, `Eliminó físicamente caso clínico id: ${req.params.id}`);
    res.json({ message: 'Ok' });
  } catch (e) { handleErr(res, e); }
});

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

app.get('/api/apoyos', async (req, res) => {
  try {
    let q = "SELECT * FROM apoyo_beneficio WHERE COALESCE(estado, 'activo')='activo'";
    let params = [];
    let rolLimpio = (req.query.usuario_rol || req.query.rol || '').toLowerCase().trim();
    let emailLimpio = (req.query.usuario_email || req.query.email || '').toLowerCase().trim();
    const staff = ['administrador', 'admin', 'supervisor'];

    if (staff.includes(rolLimpio) || emailLimpio.includes('admin') || emailLimpio === 'coordinador@mascotasunidas.org') {
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
    
    const urlImagenMascota = await procesarYSubirImagen(req.body.imagen_mascota, 'apoyos_campañas');
    const urlDocumentoRespaldo = await procesarYSubirImagen(req.body.documento_respaldo, 'apoyos_documentos');
    const urlComprobantesGasto = await procesarYSubirImagen(req.body.comprobantes_gasto || req.body.documento_respaldo, 'apoyos_documentos');
    const urlFotoDni = await procesarYSubirImagen(req.body.foto_dni, 'apoyos_dni');
    const urlImagenGeneral = await procesarYSubirImagen(req.body.imagen || req.body.imagen_mascota, 'apoyos_campañas');
    const urlFotosMascota = await procesarYSubirImagen(req.body.fotos_mascota || req.body.imagen_mascota, 'apoyos_campañas');
    const urlEvidenciaRescatista = await procesarYSubirImagen(req.body.evidencia_rescatista, 'apoyos_documentos');
    const urlComprobantesUso = await procesarYSubirImagen(req.body.comprobantes_uso, 'apoyos_documentos');
    
    const sql = `INSERT INTO apoyo_beneficio 
      (usuario_id, nombre_solicitante, dni_solicitante, correo_solicitante, telefono_solicitante, 
       motivo_ayuda, historia, meta_recaudacion, monto_recaudado, ubicacion, 
       latitud, longitud, imagen_mascota, documento_respaldo, comprobantes_gasto, 
       estado_revision, motivo_rechazo, denuncias_count, foto_dni, titulo, 
       descripcion, nombre_mascota, tipo_apoyo, numero_contacto, contacto, 
       imagen, fotos_mascota, tipo_documento_respaldo, evidencia_rescatista, enlace_redes, 
       monto_meta, monto_objetivo, comprobantes_uso, actualizaciones, estado, 
       usuario_email, fecha_publicacion, enlace_documento) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'activo', ?, ?, ?)`;
      
    const values = [
      userId, req.body.nombre_solicitante || '', req.body.dni_solicitante || '', emailSol, req.body.telefono_solicitante || '',
      req.body.motivo_ayuda || '', req.body.historia || '', metaRecaudacion, parseFloat(req.body.monto_recaudado) || 0.00,
      req.body.ubicacion || 'La Libertad, Perú', parseFloat(req.body.latitud) || -8.1119, parseFloat(req.body.longitud) || -79.0286,
      urlImagenMascota, urlDocumentoRespaldo, urlComprobantesGasto, req.body.estado_revision || 'pendiente', urlFotoDni,
      req.body.titulo || 'Campaña', req.body.descripcion || req.body.historia || '', req.body.nombre_mascota || 'Mascota',
      req.body.tipo_apoyo || 'DINERO', req.body.numero_contacto || '', req.body.contacto || '', urlImagenGeneral, urlFotosMascota,
      typeDoc, urlEvidenciaRescatista, linkRedes, metaAdd, objEsp, urlComprobantesUso, emailSol, req.body.fecha_publicacion || null, driveDoc
    ];
    
    const [r] = await pool.query(sql, values);
    await registrarMovimiento(userId, emailSol, 'CREAR', 'apoyo_beneficio', r.insertId, `Registró campaña: ${req.body.titulo}`);
    res.status(201).json({ message: 'Ok' });
  } catch (e) { handleErr(res, e); }
});

// 🟢 CORREGIDO: Endpoint Apoyos/Revision ahora procesa y guarda motivo_rechazo y actualizaciones
app.put('/api/apoyos/revision/:id', async (req, res) => {
  try {
    const { estado_revision, motivo_rechazo, actualizaciones } = req.body;
    
    await pool.query(
      'UPDATE apoyo_beneficio SET estado_revision=?, motivo_rechazo=?, actualizaciones=? WHERE donacion_id=?', 
      [estado_revision, motivo_rechazo || null, actualizaciones || null, req.params.id]
    );
    
    await registrarMovimiento(1, 'admin@mascotas.com', 'REVISIÓN', 'apoyo_beneficio', req.params.id, `Cambió estado de revisión a: ${estado_revision}`);
    res.json({ message: 'Ok' });
  } catch (e) { handleErr(res, e); }
});

app.delete('/api/apoyos/:id', async (req, res) => {
  try {
    await pool.query("UPDATE apoyo_beneficio SET estado='inactivo' WHERE donacion_id=?", [req.params.id]);
    res.json({ message: 'Ok' });
  } catch (e) { handleErr(res, e); }
});

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

app.get('/api/mapa-global', async (req, res) => {
  try {
    const [adopciones] = await pool.query(`
      SELECT 
        mascota_id as id, 'adopcion' as tipo, nombre, etapa, raza, ubicacion, latitud, longitud, notas, 
        imagen, usuario_email, fecha_publicacion as fecha, COALESCE(estado, 'activo') as estado, celular_contacto,
        raza as detalles_raza, etapa as detalles_etapa, COALESCE(estado, 'activo') as detalles_estado
      FROM mascotas_adopcion WHERE COALESCE(estado, 'activo') = 'activo'
    `);
    
    const [perdidos] = await pool.query(`
      SELECT 
        alerta_id as id, 'perdido' as tipo, nombre, raza, celular as celular_contacto, dueno, 
        fecha_extravio, ubicacion, notas, latitud, longitud, imagen, usuario_email, 
        recompensa, fecha_publicacion as fecha, COALESCE(estado, 'activo') as estado,
        raza as detalles_raza, dueno as detalles_dueno, fecha_extravio as detalles_fecha_extravio, recompensa as detalles_recompensa
      FROM mascotas_perdidas WHERE COALESCE(estado, 'activo') = 'activo'
    `);
    
    const [rescates] = await pool.query(`
      SELECT 
        ficha_id as id, 'rescate' as tipo, nombre, especie, estado_clinico, ubicacion, notas, 
        latitud, longitud, imagen, usuario_email, celular_contacto, fecha_publicacion as fecha,
        especie as detalles_especie, estado_clinico as detalles_estado_clinico
      FROM registro_rescates
    `);
    
    const [apoyos] = await pool.query(`
      SELECT 
        donacion_id as id, 'apoyo' as tipo, nombre_solicitante, dni_solicitante, correo_solicitante, 
        telefono_solicitante, motivo_ayuda, historia as notas, meta_recaudacion, monto_recaudado, 
        ubicacion, latitud, longitud, imagen_mascota as imagen, documento_respaldo, comprobantes_gasto, 
        estado_revision, foto_dni, titulo as nombre, descripcion, nombre_mascota, tipo_apoyo, 
        numero_contacto as celular_contacto, contacto as dueno, fotos_mascota, tipo_documento_respaldo, 
        evidencia_rescatista, enlace_redes, monto_meta, monto_objetivo, comprobantes_uso, COALESCE(estado, 'activo') as estado, 
        usuario_email, fecha_publicacion as fecha, enlace_documento,
        nombre_mascota as detalles_nombre_mascota, motivo_ayuda as detalles_motivo_ayuda, tipo_apoyo as detalles_tipo_apoyo,
        meta_recaudacion as detalles_meta_recaudacion, monto_recaudado as detalles_monto_recaudado,
        monto_meta as detalles_monto_meta, monto_objetivo as detalles_monto_objetivo, enlace_redes as detalles_enlace_redes, enlace_documento as detalles_enlace_documento
      FROM apoyo_beneficio WHERE estado_revision = 'aprobado' AND COALESCE(estado, 'activo') = 'activo'
    `);
    
    const mapaGlobal = [...adopciones, ...perdidos, ...rescates, ...apoyos];
    res.json(mapaGlobal);
  } catch (e) { 
    console.error("Error mapa-global:", e);
    res.status(500).json({ error: e.message }); 
  }
});

// 🟢 CORREGIDO: Las notificaciones ahora sacan el rechazo al tope de la lista visual con CURRENT_TIMESTAMP
app.get('/api/notificaciones', async (req, res) => {
  try {
    const emailUsuario = req.query.email || '';
    
    let sql = `
      SELECT 'solicitud' as tipo, 'Trámite Adopción' as titulo, CONCAT(s.usuario_solicitante, ' solicitó la adopción de ', s.nombre_mascota) as subtitulo, s.fecha_solicitud as orden FROM solicitudes_adopcion s INNER JOIN mascotas_adopcion m ON s.mascota_id = m.mascota_id WHERE COALESCE(m.estado, 'activo')='activo' 
      UNION ALL 
      SELECT 'adopcion' as tipo, 'Nueva Adopción' as titulo, CONCAT('Se publicó a ', nombre, ' en adopción') as subtitulo, fecha_publicacion as orden FROM mascotas_adopcion WHERE COALESCE(estado, 'activo')='activo' 
      UNION ALL 
      SELECT 'perdido' as tipo, 'Alerta Roja' as titulo, CONCAT('Mascota extraviada: ', nombre) as subtitulo, fecha_publicacion as orden FROM mascotas_perdidas WHERE COALESCE(estado, 'activo')='activo'
      UNION ALL 
      SELECT 'rescate' as tipo, 'Emergencia Médica' as titulo, CONCAT('Caso clínico reportado: ', nombre) as subtitulo, fecha_publicacion as orden FROM registro_rescates
      UNION ALL 
      SELECT 'apoyo' as tipo, 'Campaña de Apoyo' as titulo, CONCAT('Nueva campaña: ', titulo) as subtitulo, fecha_publicacion as orden FROM apoyo_beneficio WHERE COALESCE(estado, 'activo')='activo' AND estado_revision='aprobado'
    `;

    if (emailUsuario) {
      sql += `
        UNION ALL
        SELECT 'rechazado' as tipo, '🔴 Apoyo Rechazado' as titulo, CONCAT('Tu campaña fue rechazada. Motivo: ', IFNULL(motivo_rechazo, 'No cumple requisitos')) as subtitulo, CURRENT_TIMESTAMP as orden 
        FROM apoyo_beneficio 
        WHERE estado_revision = 'rechazado' AND (LOWER(correo_solicitante) = LOWER(${pool.escape(emailUsuario)}) OR LOWER(usuario_email) = LOWER(${pool.escape(emailUsuario)}))
      `;
    }

    sql += ` ORDER BY orden DESC LIMIT 15`;
    
    const [notificaciones] = await pool.query(sql);
    res.json(notificaciones);
  } catch (e) { 
    handleErr(res, e); 
  }
});

app.get('/api/limpiar-notificaciones', async (req, res) => {
  try {
    await pool.query('TRUNCATE TABLE movimientos_usuarios');
    await pool.query('TRUNCATE TABLE solicitudes_adopcion');
    res.send('<h1 style="color: green; text-align: center; margin-top: 50px;">¡Limpieza exitosa! 🧹</h1>');
  } catch (error) { res.status(500).send('Error'); }
});

app.get('/api/usuarios/verificacion', async (req, res) => {
  try {
    const sql = `
      SELECT usuario_id, nombre_completo, username, correo, dni, foto_dni, estado_verificacion 
      FROM usuarios 
      WHERE estado_verificacion = 'pendiente' 
      ORDER BY usuario_id ASC
    `;
    const [usuarios] = await pool.query(sql);
    res.json(usuarios);
  } catch (e) { 
    handleErr(res, e); 
  }
});

app.get('/api/usuarios/estado/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT estado_verificacion FROM usuarios WHERE usuario_id = ?', [req.params.id]);
    if (rows.length > 0) {
      res.json({ estado: rows[0].estado_verificacion });
    } else {
      res.json({ estado: 'rechazado' });
    }
  } catch (e) { 
    handleErr(res, e); 
  }
});

app.put('/api/usuarios/verificar/:id', async (req, res) => {
  try {
    const { estado } = req.body; 
    const usuarioId = req.params.id;

    if (!['verificado', 'rechazado', 'pendiente'].includes(estado)) {
      return res.status(400).json({ error: 'Estado de verificación no válido' });
    }

    const sql = 'UPDATE usuarios SET estado_verificacion = ? WHERE usuario_id = ?';
    await pool.query(sql, [estado, usuarioId]);
    
    if (estado === 'rechazado') {
      console.log(`🧹 Limpiando publicaciones del usuario rechazado ID: ${usuarioId}`);
      await pool.query('UPDATE mascotas_adopcion SET estado="inactivo" WHERE usuario_id=?', [usuarioId]);
      await pool.query('UPDATE mascotas_perdidas SET estado="inactivo" WHERE usuario_id=?', [usuarioId]);
      await pool.query('UPDATE apoyo_beneficio SET estado="inactivo" WHERE usuario_id=?', [usuarioId]);
      await pool.query('DELETE FROM registro_rescates WHERE usuario_id=?', [usuarioId]);
      await pool.query('DELETE FROM solicitudes_adopcion WHERE usuario_id=?', [usuarioId]);
    }

    await registrarMovimiento(null, 'staff_auditoria', 'VERIFICACIÓN_DNI', 'usuarios', usuarioId, `Identidad de ID ${usuarioId} marcada como: ${estado}`);

    res.json({ message: `Identidad actualizada a: ${estado}` });
  } catch (e) { 
    handleErr(res, e); 
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 API Online en el puerto ${PORT}`));

process.on('uncaughtException', (err) => console.error(err));
process.on('unhandledRejection', (err) => console.error(err));
