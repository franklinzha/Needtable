/**
 * 附件的上传 / 地址 / 图片压缩。
 *
 * 文件存在各表自己的 Durable Object（SQLite 切块）里，不依赖 R2 —— R2 要绑信用卡才能开通。
 * 代价是容量有限（单个 10MB、单表 200MB），所以照片在上传前先在浏览器里压一遍：
 * 手机拍的 4000×3000 照片动辄 5MB，缩到 2560 边长的 JPEG/WebP 通常只剩几百 KB。
 */

import { t } from '../../shared/i18n/i18n.js';

export const MAX_BYTES = 10 * 1024 * 1024;
/** 浏览器里能直接预览的类型，与 DO 端的内联白名单一致。 */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']);
const COMPRESSIBLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/bmp']);
const MAX_DIM = 2560;
/** 比这还小的图就不折腾了。 */
const COMPRESS_OVER = 800 * 1024;

export const isImage = (type) => INLINE.has(type);

/** 公开只读链接里附件从 /api/public/<令牌>/files/ 取。 */
let publicToken = '';
/** @param {string} token */
export function usePublicFiles(token) { publicToken = token; }

/** @param {string} tableId @param {string} id */
export const fileUrl = (tableId, id) => (publicToken
  ? '/api/public/' + publicToken + '/files/' + encodeURIComponent(id)
  : '/api/tables/' + encodeURIComponent(tableId) + '/files/' + encodeURIComponent(id));

/** @param {number} n */
export function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/** 文件类型 → 一个一眼能认出的图标。 @param {string} name @param {string} type */
export function fileIcon(name, type) {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (type.startsWith('image/')) return '🖼';
  if (ext === 'pdf') return '📕';
  if (['doc', 'docx', 'txt', 'md', 'rtf'].includes(ext)) return '📄';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📗';
  if (['ppt', 'pptx'].includes(ext)) return '📙';
  if (['zip', 'rar', '7z', 'gz'].includes(ext)) return '🗜';
  if (type.startsWith('video/')) return '🎞';
  if (type.startsWith('audio/')) return '🎵';
  return '📎';
}

/**
 * 大图先压缩：长边缩到 2560，PNG 转 WebP（保留透明），其余转 JPEG。压完反而更大就用原文件。
 * @param {File} file @returns {Promise<File>}
 */
export async function prepare(file) {
  if (!COMPRESSIBLE.has(file.type) || file.size < COMPRESS_OVER || typeof createImageBitmap !== 'function') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'));
    const type = file.type === 'image/png' ? 'image/webp' : 'image/jpeg';
    if (type === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const blob = await new Promise((res) => cv.toBlob(res, type, 0.85));
    if (!blob || blob.size >= file.size || blob.type !== type) return file;
    const dot = file.name.lastIndexOf('.');
    const base = dot > 0 ? file.name.slice(0, dot) : file.name;
    return new File([blob], base + (type === 'image/webp' ? '.webp' : '.jpg'), { type });
  } catch {
    return file;                               // 解不开的图（HEIC 之类）原样上传
  }
}

/**
 * 上传一个文件。用 XHR 而不是 fetch，是为了拿到上传进度。
 * @param {string} tableId @param {File} file @param {(p:number)=>void} [onProgress]
 * @returns {Promise<{id:string, n:string, t:string, s:number}>}
 */
export function upload(tableId, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/tables/' + encodeURIComponent(tableId) + '/files');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name || '附件'));
    xhr.setRequestHeader('x-file-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      /** @type {any} */ let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* 非 JSON */ }
      if (xhr.status === 401) { location.reload(); reject(new Error(t('登录已过期'))); return; }
      if (xhr.status >= 200 && xhr.status < 300 && data?.id) resolve(data);
      else reject(new Error(data?.error?.message || t('上传失败（HTTP {status}）', { status: xhr.status })));
    };
    xhr.onerror = () => reject(new Error(t('网络错误，上传失败')));
    xhr.send(file);
  });
}
