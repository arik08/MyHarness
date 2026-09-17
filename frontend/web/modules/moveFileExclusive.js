import fs from "node:fs/promises";
import { constants } from "node:fs";

// Checking existence before rename is insufficient: rename may replace a file
// created by another request between that check and the actual move.
export async function moveFileExclusive(source, destination) {
  try {
    await fs.link(source, destination);
  } catch (error) {
    if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) throw error;
    await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
  }
  // If removal fails, keep both names. Never risk deleting the only good copy
  // or an unrelated destination while attempting to roll back.
  await fs.unlink(source);
}
