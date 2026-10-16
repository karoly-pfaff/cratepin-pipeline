async function checkedImage(url, sha256) {
  const image = document.createElement('img');
  image.src = url;
  await image.decode();
  const bytes = await (await fetch(url)).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actual = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  if (actual !== sha256) throw new Error(`Content mismatch: ${url}`);
  return image;
}

async function displayVariant(section, variant) {
  const image = await checkedImage(variant.url, variant.sha256);
  if (
    image.naturalWidth !== variant.comparison.width ||
    image.naturalHeight !== variant.comparison.height
  )
    throw new Error(`Geometry mismatch: ${variant.url}`);
  const figure = document.createElement('figure');
  const label = document.createElement('figcaption');
  label.textContent = `${variant.profile}: ${image.naturalWidth}×${image.naturalHeight}, ${variant.outputBytes} bytes`;
  figure.append(image, label);
  section.append(figure);
  return {
    url: variant.url,
    width: image.naturalWidth,
    height: image.naturalHeight,
    hasMatchingHash: true,
  };
}

function pictureWithUnsupportedSource(fallback) {
  const unsupported = document.createElement('source');
  unsupported.type = 'image/x-cratepin-unsupported';
  unsupported.srcset = 'never-request-this.avif';
  const picture = document.createElement('picture');
  picture.append(unsupported, fallback);
  return picture;
}

async function checkFallback(section, asset, id) {
  const fallback = document.createElement('img');
  fallback.src = asset.fallback.url;
  fallback.alt = id;
  section.append(pictureWithUnsupportedSource(fallback));
  await fallback.decode();
  if (!fallback.currentSrc.endsWith(asset.fallback.url) || fallback.alt !== id)
    throw new Error('Logical ID/fallback mismatch');
  return { id, selected: fallback.currentSrc, hasPreservedLogicalId: true };
}

async function checkResponsiveVariant(section, asset, id) {
  const source = document.createElement('source');
  source.type = 'image/avif';
  source.srcset = asset.variants
    .filter((variant) => variant.profile === 'avif-lossless')
    .map((variant) => `${variant.url} ${variant.comparison.width}w`)
    .join(', ');
  source.sizes = `${Math.max(1, Math.floor(asset.fallback.width / 2))}px`;
  const fallback = await checkedImage(asset.fallback.url, asset.fallback.sha256);
  fallback.alt = id;
  return attachResponsivePicture(section, { source, fallback });
}

async function attachResponsivePicture(section, { source, fallback }) {
  const picture = document.createElement('picture');
  picture.append(source, fallback);
  section.append(picture);
  await fallback.decode();
  return { id: fallback.alt, selected: fallback.currentSrc, naturalWidth: fallback.naturalWidth };
}

async function checkAsset(id, asset) {
  const section = document.createElement('section');
  const title = document.createElement('h2');
  title.textContent = id;
  section.append(title);
  document.querySelector('main').append(section);
  const variants = [];
  for (const variant of asset.variants) variants.push(await displayVariant(section, variant));
  return {
    id,
    variants,
    fallback: await checkFallback(section, asset, id),
    responsive: await checkResponsiveVariant(section, asset, id),
  };
}

async function runBrowserEvaluation() {
  const report = await (await fetch('./variant-evaluation.json')).json();
  const assets = [];
  for (const [id, asset] of Object.entries(report.assets)) assets.push(await checkAsset(id, asset));
  return { userAgent: navigator.userAgent, assets, hasPassed: true };
}

runBrowserEvaluation().then(
  (report) => {
    document.querySelector('#results').textContent = JSON.stringify(report, null, 2);
  },
  (error) => {
    document.querySelector('#results').textContent = JSON.stringify({
      hasPassed: false,
      error: error.message,
    });
  },
);
