export async function uploadToImgBB(buffer, mimeType = 'image/jpeg') {
  const key = process.env.IMGBB_API_KEY;
  if (!key) throw new Error('IMGBB_API_KEY not configured');
  if (!buffer || !buffer.length) throw new Error('Empty image buffer');
  if (buffer.length > 2 * 1024 * 1024) {
    throw new Error('Image is larger than 2MB after processing');
  }
  const base64 = buffer.toString('base64');
  const params = new URLSearchParams();
  params.append('image', base64);
  const res = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    body: params
  });
  const json = await res.json().catch(() => ({}));
  if (!json || !json.success || !json.data || !json.data.url) {
    throw new Error('ImgBB upload failed');
  }
  return json.data.url;
}