// What happens after a card is saved: where "View" points, and how long the
// confirmation stays up. Pure, so both rules have a test.

const MEDIA = 'content://media/';
const IMAGES = `${MEDIA}external/images/media/`;

/**
 * The content URI that opens a saved card in the gallery, or null.
 *
 * In expo-media-library 57 `Asset.create` returns an Asset whose `id` on
 * Android is ALREADY the MediaStore content URI (content://media/external/
 * images/media/<n>, or external_primary on Android 10), so it is used as it
 * is. A bare number is a MediaStore row id and gets the images prefix. Anything
 * else is refused: this string goes to Linking.openURL, and a URI that is not
 * MediaStore's is not one the app made.
 */
export function viewUri(id) {
  if (typeof id === 'number' && Number.isInteger(id) && id > 0) return `${IMAGES}${id}`;
  if (typeof id !== 'string') return null;
  if (/^[1-9][0-9]*$/.test(id)) return `${IMAGES}${id}`;
  return id.startsWith(MEDIA) && /\/[0-9]+$/.test(id) ? id : null;
}

export const NOTICE_MS = 2500;
// With a button on it: a thumb has to read the sentence, decide, and reach the
// chip, and a chip that vanishes under the finger is worse than none.
export const NOTICE_ACTION_MS = 6000;

/** How long a notice stays, given whether it carries an action. */
export function noticeMs(hasAction) {
  return hasAction ? NOTICE_ACTION_MS : NOTICE_MS;
}
