export const archiveWorkerVersion = 'vesperwind-archive/1 libarchive/libarchive 3.8.9 zip,tar,tgz,rar,rar5,7z liblzma/5.8.3 codecs=copy,lzma,lzma2 memory=536870912'
export const compatibleArchiveWorker = (version) => String(version || '').trim() === archiveWorkerVersion
