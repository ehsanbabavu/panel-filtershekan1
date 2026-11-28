export const ANDROID_APK_NAME = 'Ariya-connect.apk';
export const ANDROID_APK_PART_BYTES = 2 * 1024 * 1024;
export const ANDROID_APK_MAX_BYTES = 100 * 1024 * 1024;

export type AndroidApk = { id: string; name: string; size: number; uploadedAt: string };
