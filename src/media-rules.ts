export function byteRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(size) || size <= 0) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return Number.isSafeInteger(suffix) && suffix > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : null;
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < size && end >= start ? { start, end: Math.min(end, size - 1) } : null;
}

export function requestedSeasons(mediaInfo: any): number[] {
  const seasons = (mediaInfo?.requests || []).filter((request: any) => !request.is4k && [1, 2].includes(request.status))
    .flatMap((request: any) => (request.seasons || []).filter((season: any) => [1, 2].includes(season.status ?? request.status)).map((season: any) => Number(season.seasonNumber)));
  return [...new Set<number>(seasons.filter((number: number) => Number.isSafeInteger(number) && number >= 0))];
}

export function changeSubscription<T extends { id: string; name: string }>(current: T[], body: { subscriptionAdd?: T; subscriptionRemove?: string }): T[] {
  if (body.subscriptionRemove !== undefined) {
    if (!/^[A-Za-z0-9_-]{24}$/.test(body.subscriptionRemove)) throw Object.assign(new Error('Invalid creator identifier.'), { status: 400 });
    return current.filter(entry => entry.id !== body.subscriptionRemove);
  }
  const creator = body.subscriptionAdd;
  if (!creator || !/^[A-Za-z0-9_-]{24}$/.test(creator.id) || typeof creator.name !== 'string' || creator.name.length > 120) throw Object.assign(new Error('Invalid YouTube subscription.'), { status: 400 });
  if (current.length >= 30 && !current.some(entry => entry.id === creator.id)) throw Object.assign(new Error('You can subscribe to up to 30 creators.'), { status: 409 });
  return [...current.filter(entry => entry.id !== creator.id), creator];
}
