export const PLAYLIST_ROW_MIME = 'application/x-vesperwind-playlist-row'
export const readPlaylistRowDrop = (transfer) => {
  if (!Array.from(transfer?.types || []).includes(PLAYLIST_ROW_MIME)) return null
  return transfer.getData(PLAYLIST_ROW_MIME) || null
}
