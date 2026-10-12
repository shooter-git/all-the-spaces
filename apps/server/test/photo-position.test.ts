import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { fieldOfView, photoPosition } from '../src/photo-position.ts';

/** A photo as a phone saves one: where it was taken, which way it faced, its lens. */
const phonePhoto = (gps: Record<string, string>, focal35?: string) =>
  sharp({ create: { width: 400, height: 300, channels: 3, background: '#8899aa' } })
    .withExifMerge({
      IFD0: { Make: 'PhoneCo', Model: 'Phone 12' },
      ...(focal35 ? { IFD2: { FocalLengthIn35mmFilm: focal35 } } : {}),
      IFD3: gps,
    })
    .jpeg()
    .toBuffer();

describe('where a photo was taken', () => {
  it('reads the position, the way it faces, the altitude and the lens', async () => {
    const photo = await phonePhoto(
      {
        GPSLatitudeRef: 'N',
        GPSLatitude: '30/1 16/1 2335/100',
        GPSLongitudeRef: 'W',
        GPSLongitude: '97/1 44/1 4710/100',
        GPSImgDirectionRef: 'T',
        GPSImgDirection: '2905/10',
        GPSAltitudeRef: '0',
        GPSAltitude: '1625/10',
      },
      '26',
    );
    const p = photoPosition(photo);
    expect(p?.lat).toBeCloseTo(30 + 16 / 60 + 23.35 / 3600, 6);
    expect(p?.lng).toBeCloseTo(-(97 + 44 / 60 + 47.1 / 3600), 6);
    expect(p?.heading).toBeCloseTo(290.5, 5);
    expect(p?.altitude).toBeCloseTo(162.5, 5);
    expect(p?.focal35).toBe(26);
  });

  it('south and east, without a heading', async () => {
    const p = photoPosition(
      await phonePhoto({
        GPSLatitudeRef: 'S',
        GPSLatitude: '33/1 51/1 2448/100',
        GPSLongitudeRef: 'E',
        GPSLongitude: '151/1 12/1 5508/100',
      }),
    );
    expect(p?.lat).toBeCloseTo(-33.8568, 3);
    expect(p?.lng).toBeCloseTo(151.2153, 3);
    expect(p?.heading).toBeUndefined();
  });

  it('finds the details inside other containers too (an iPhone HEIC keeps them as an item)', async () => {
    const photo = await phonePhoto({
      GPSLatitudeRef: 'N',
      GPSLatitude: '51/1 30/1 0/1',
      GPSLongitudeRef: 'W',
      GPSLongitude: '0/1 7/1 3/1',
    });
    const { exif } = await sharp(photo).metadata();
    // Somewhere in a box-structured file, after other boxes.
    const heicLike = Buffer.concat([
      Buffer.from('\0\0\0\x18ftypheic\0\0\0\0mif1heic'),
      Buffer.alloc(300, 7),
      Buffer.from([0, 0, 0, 6]),
      exif as Buffer,
    ]);
    expect(photoPosition(heicLike)?.lat).toBeCloseTo(51.5, 6);
  });

  it('is nothing for a photo without a position, or a file that isn’t a photo', async () => {
    const plain = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#000' },
    })
      .withExifMerge({ IFD0: { Make: 'PhoneCo' } })
      .jpeg()
      .toBuffer();
    expect(photoPosition(plain)).toBeNull();
    expect(photoPosition(Buffer.from('not a photo at all'))).toBeNull();
    expect(photoPosition(Buffer.from('Exif\0\0MM\0*\0\0\0\x08\0'))).toBeNull();
  });

  it('turns a lens into a field of view across the picture', () => {
    // A phone's main camera (26 mm equivalent): about 69° across a landscape photo.
    expect(fieldOfView(26, 4032, 3024)).toBeCloseTo(69.4, 1);
    expect(fieldOfView(26, 3024, 4032)).toBeCloseTo(49.6, 1);
  });
});
