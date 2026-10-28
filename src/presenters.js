// Shapes stored records into what the API returns to clients.
import * as v from './validate.js';

const DEFAULT_GARMENT_PRICE = 499;

export function garmentPrice(garment) {
  return v.GARMENT_PRICES[garment] ?? DEFAULT_GARMENT_PRICE;
}

export function createPresenters({ store, now }) {
  function publicDesign(design, viewerId) {
    const liked = viewerId
      ? Boolean(store.get('likes', `${design.id}:${viewerId}`))
      : false;

    return {
      id: design.id,
      name: design.name,
      garment: design.garment,
      baseColor: design.baseColor,
      front: design.front,
      back: design.back,
      creatorName: design.ownerName,
      creatorHandle: design.handle,
      likeCount: design.likeCount,
      remixCount: design.remixCount,
      remixedFrom: design.remixedFrom ?? null,
      lineage: design.lineage ?? [],
      published: design.published,
      createdAt: design.createdAt,
      price: garmentPrice(design.garment),
      challengeId: design.challengeId ?? null,
      designJson: design.designJson ?? null,
      previewImage: design.previewImage ?? null,
      backPreviewImage: design.backPreviewImage ?? null,
      liked,
      mine: design.ownerId === viewerId,
    };
  }

  function isOpen(challenge) {
    const time = now();
    return time >= Date.parse(challenge.startsAt) && time < Date.parse(challenge.endsAt);
  }

  function entriesOf(challenge) {
    return store.list('designs', (d) => d.challengeId === challenge.id && d.published);
  }

  function publicChallenge(challenge) {
    return {
      id: challenge.id,
      title: challenge.title,
      description: challenge.description,
      startsAt: challenge.startsAt,
      endsAt: challenge.endsAt,
      open: isOpen(challenge),
      entries: entriesOf(challenge).length,
    };
  }

  return { publicDesign, isOpen, entriesOf, publicChallenge };
}
