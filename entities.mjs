import { loadEntities, getSentLog, sentKey, isAuthorised } from "../../lib/reminders.mjs";

export default async (req) => {
  if (!isAuthorised(req)) {
    return Response.json({ error: "The password is incorrect." }, { status: 401 });
  }

  try {
    const [{ today, entities }, log] = await Promise.all([loadEntities(), getSentLog()]);
    const withLog = entities.map((e) => ({
      ...e,
      emailSentAt: e.renewal && log[sentKey(e)] ? log[sentKey(e)].sentAt : null,
    }));
    return Response.json({ today, entities: withLog });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
};

export const config = {
  path: "/api/entities",
};
