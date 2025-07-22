export async function putS3Object(env: any, key: string, body: Uint8Array) {
  // 1. Authorize
  const authRes = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    headers: {
      Authorization: 'Basic ' + btoa(`${env.B2_KEY_ID}:${env.B2_APP_KEY}`)
    }
  });
  const authData = await authRes.json();

  // 2. Get upload URL
  const uploadUrlRes = await fetch(`${authData.apiUrl}/b2api/v2/b2_get_upload_url`, {
    method: 'POST',
    headers: { Authorization: authData.authorizationToken },
    body: JSON.stringify({ bucketId: env.B2_BUCKET_ID })
  });
  const uploadUrlData = await uploadUrlRes.json();

  // 3. Upload file
  const uploadRes = await fetch(uploadUrlData.uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: uploadUrlData.authorizationToken,
      'X-Bz-File-Name': encodeURIComponent(key),
      'Content-Type': 'application/pdf',
      'X-Bz-Content-Sha1': 'do_not_verify', // for small files, this is fine
    },
    body: body
  });

  if (!uploadRes.ok) {
    throw new Error(`Failed to upload to B2: ${await uploadRes.text()}`);
  }
  return await uploadRes.json();
}

export async function getS3Object(env: any, key: string) {
  // 1. Authorize
  const authRes = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    headers: {
      Authorization: 'Basic ' + btoa(`${env.B2_KEY_ID}:${env.B2_APP_KEY}`)
    }
  });
  const authData = await authRes.json();

  // 2. Download file
  // B2 download URLs are of the form:
  //   {downloadUrl}/file/{bucketName}/{fileName}
  const downloadUrl = `${authData.downloadUrl}/file/${env.B2_BUCKET}/${key}`;
  const downloadRes = await fetch(downloadUrl, {
    headers: {
      Authorization: authData.authorizationToken
    }
  });
  if (!downloadRes.ok) {
    throw new Error(`Failed to download from B2: ${await downloadRes.text()}`);
  }
  const body = await downloadRes.arrayBuffer();
  return {
    Body: body,
    ContentType: downloadRes.headers.get('Content-Type') || 'application/pdf',
    ContentDisposition: downloadRes.headers.get('Content-Disposition') || undefined,
  };
}