import { assetUrlOf, loadAssetUrls, siteBaseUrl } from './assetUrls.js';
import forest from './scenes/forest.json';

/** Points each media element at the asset its scene names by logical ID and waits for the images. */
async function showScene(scene, assetUrls) {
  const background = document.querySelector('#background');
  const actor = document.querySelector('#actor');
  background.src = assetUrlOf(assetUrls, scene.background).href;
  actor.src = assetUrlOf(assetUrls, scene.actor).href;
  document.querySelector('#prompt').src = assetUrlOf(assetUrls, scene.prompt).href;
  await Promise.all([background.decode(), actor.decode()]);
}

/** Loads the asset manifest once, at startup; every scene then looks its assets up in it. */
async function start() {
  const assetUrls = await loadAssetUrls(siteBaseUrl(import.meta.env.BASE_URL, document.baseURI));
  await showScene(forest, assetUrls);
}

const status = document.querySelector('#status');
start().then(
  () => {
    status.textContent = 'Assets loaded';
  },
  (error) => {
    status.textContent = `Assets failed: ${error.message}`;
  },
);
