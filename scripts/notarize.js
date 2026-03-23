const { notarize } = require("@electron/notarize");

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_ID_PASSWORD;
  if (!process.env.APPLE_ID || !appleIdPassword || !process.env.APPLE_TEAM_ID) {
    console.log("Skipping notarization: Apple credentials not set");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`Notarizing ${appPath}...`);

  await notarize({
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: appleIdPassword,
    teamId: process.env.APPLE_TEAM_ID,
  });

  console.log("Notarization complete.");
};
