import { google } from "googleapis";

const serviceAccountKeyFile = "./private.json";
// const serviceAccountKeyFile = process.env.PATH_TO_KEY;

async function _getGoogleSheetClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: serviceAccountKeyFile,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  try {
    const authClient = await auth.getClient();
    return google.sheets({
      version: "v4",
      auth: authClient,
    });
  } catch (err) {
    console.log(err);
    return null;
  }
}

async function _readGoogleSheet(googleSheetClient, sheetId, tabName, range) {
  if (!googleSheetClient) {
    console.log("No google sheet client");
    return [];
  }
  try {
    const res = await googleSheetClient.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${tabName}!${range}`,
    });

    return res.data.values;
  } catch (err) {
    return;
  }
}

async function _writeGoogleSheet(
  googleSheetClient,
  sheetId,
  tabName,
  range,
  values
) {
  await googleSheetClient.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: `${tabName}!A:A`,
  });
  await googleSheetClient.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${tabName}!${range}`,
    valueInputOption: "RAW",
    resource: { values },
  });
}

export { _readGoogleSheet, _writeGoogleSheet, _getGoogleSheetClient };
