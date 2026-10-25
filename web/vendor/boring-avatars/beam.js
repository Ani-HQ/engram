/* Beam geometry adapted from Boring Avatars, MIT (c) 2021 boringdesigners.
 * Pinned upstream and adaptation details: ./SOURCE.md. No React runtime needed. */
const SIZE = 36;
const getDigit = (number, position) => Math.floor((number / Math.pow(10, position)) % 10);
const getBoolean = (number, position) => !(getDigit(number, position) % 2);
const getUnit = (number, range, index) => {
  const value = number % range;
  return index && getDigit(number, index) % 2 === 0 ? -value : value;
};

/** Fixed geometry only. Callers select a local palette; identifiers never enter SVG. */
export function beamData(seed, paletteSize = 5) {
  const number = Number.isSafeInteger(seed) ? seed >>> 0 : 0;
  const count = Number.isInteger(paletteSize) && paletteSize > 0 && paletteSize <= 32 ? paletteSize : 5;
  const preTranslateX = getUnit(number, 10, 1);
  const wrapperTranslateX = preTranslateX < 5 ? preTranslateX + SIZE / 9 : preTranslateX;
  const preTranslateY = getUnit(number, 10, 2);
  const wrapperTranslateY = preTranslateY < 5 ? preTranslateY + SIZE / 9 : preTranslateY;
  return {
    wrapperIndex: number % count,
    backgroundIndex: (number + 13) % count,
    wrapperTranslateX,
    wrapperTranslateY,
    wrapperRotate: getUnit(number, 360),
    wrapperScale: 1 + getUnit(number, SIZE / 12) / 10,
    isMouthOpen: getBoolean(number, 2),
    isCircle: getBoolean(number, 1),
    eyeSpread: getUnit(number, 5),
    mouthSpread: getUnit(number, 3),
    faceRotate: getUnit(number, 10, 3),
    faceTranslateX: wrapperTranslateX > SIZE / 6 ? wrapperTranslateX / 2 : getUnit(number, 8, 1),
    faceTranslateY: wrapperTranslateY > SIZE / 6 ? wrapperTranslateY / 2 : getUnit(number, 7, 2),
  };
}
