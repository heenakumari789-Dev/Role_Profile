# Linking the MRF Form to a role profile

The MRF Form in Zoho Recruit asks for a **Requisition of Sangh** and a **Requisition for
Designation**. When the form is saved, Recruit asks the portal whether that designation
already has a role profile, and writes the answer back onto the record.

Nothing is copied into Recruit. The record holds a **link**, so clicking it opens the live
role profile — always the current version, never a stale attachment.

## 1. Fields to add on the MRF Form module

| Field label | Type | Holds |
| --- | --- | --- |
| Role Profile Link | URL | Opens the role profile, or the form to create one |
| Role Profile Status | Single line | `Linked — v2`, `Not created yet`, `Designation not recognised` |
| Role Profile Checked At | Date/Time | When the portal was last asked |

Use whatever labels suit you; the function refers to them by API name, which you can see in
*Setup → Modules and Fields → MRF Form → each field → API Name*.

## 2. The portal side

Set two values in the portal's `.env`, then restart it:

```
API_TOKEN=<a long random string you generate>
PUBLIC_URL=https://<the address Zoho can reach the portal on>
```

`API_TOKEN` empty means the API stays off and answers 503, so it cannot be left open by
accident. Check it works:

```
curl -H "X-API-Token: <token>" "<PUBLIC_URL>/api/ping"
```

**The portal has to be reachable from Zoho's servers.** `localhost:3000` is not — Zoho
calls from its own network. Put the portal on a real address before wiring this up.

## 3. The custom function in Recruit

*Setup → Automation → Actions → Custom Function*, then attach it to a workflow rule on the
MRF Form module for **create and edit**.

```javascript
// Arguments to map from the record: sangh, designation, recordId
portal = "https://<PUBLIC_URL>";
token  = "<API_TOKEN>";

url = portal + "/api/role-profile?sangh=" + zoho.encryption.urlEncode(sangh)
    + "&designation=" + zoho.encryption.urlEncode(designation)
    + "&mrf=" + recordId;

response = invokeurl
[
    url: url
    type: GET
    headers: {"X-API-Token": token}
];

update = Map();

if(response.get("status") == "found")
{
    update.put("Role_Profile_Link", response.get("url"));
    update.put("Role_Profile_Status", "Linked - v" + response.get("version"));
}
else if(response.get("designation_in_use") == true)
{
    // Real designation, no profile yet: the link opens the form ready to write one.
    update.put("Role_Profile_Link", response.get("create_url"));
    update.put("Role_Profile_Status", "Not created yet");
}
else
{
    update.put("Role_Profile_Link", response.get("create_url"));
    update.put("Role_Profile_Status", "Designation not recognised");
}

update.put("Role_Profile_Checked_At", zoho.currentdate);
zoho.recruit.updateRecord("CustomModule1", recordId, update);
```

Replace `CustomModule1` and the field API names with yours. Recruit shows custom functions
under *Setup → Automation*; `invokeurl` is how a function calls out to another system.

## 4. What happens in each case

**The designation has a role profile** — the link opens it. Whoever clicks signs in to the
portal first if they are not already; they then land on the profile itself. Only people
allowed to see that profile can, which is why this is a link and not a copy.

**The designation is real but has no profile** — the link opens the portal's create form
with the sangh and designation already chosen, and a note saying where the request came
from. Once it is written and approved, the profile exists and the link resolves to it.

**The designation is not one any active member holds** — the status says so. Usually a
spelling difference between the two systems. Making *Requisition for Designation* a picklist
rather than free text removes this class of problem entirely.

## 5. Keeping it current

The function runs on create and edit, so re-saving an MRF record refreshes the link. A
newly written profile therefore shows up the next time the record is touched.

To have the portal tell Recruit the moment a profile is approved, it needs to call Recruit's
API, which means OAuth credentials for Recruit (client id, secret, refresh token) in the
portal's `.env`. That is a separate piece of work — say the word.

## What the API deliberately does not return

Assessment scores, ratings and training gaps are never included. They are a member's
performance record, not recruitment data, and Recruit is not the place for them.
