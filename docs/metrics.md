# Essential Flash Shield Study

This Shield Study is meant to understand the use of Essential vs. Non-
Essential Flash on the web, with the ultimate goal of enabling us to fine-tune
allow/block lists in order to change the Click-To-Activate setting of the
Flash plugin to be "Ask to Activate" by default (as opposed to "Always
Allow").

This study will recruit users in the beta / release channels via the shield
opt-in mechanism, and users who accept the terms will participate in the study
and will submit an external telemetry ping according to the Data collection
described below.

## Data collection

The data collection, which is meant to support the reports and data analysis
requested at the [study document](https://docs.google.com/document/d/1sYp0DNio
PA5iF3iw9LHGf1uN5B5AgdCu7jJxAh0MiqA/edit#heading=h.ki2euufqck3g), will send
the following payload using an external telemetry ping:

```js
    payload = {
        "clientID": 123,
        "locale": "en-US",
        "geo": "US",
        "flashVersion": "123.45-x86",
        "datetime": 1486908000000,
        "profileAge": 345,
        "daysInExperiment": 10,
        "experimentGroup": "week1 | week2 | etc.. | control",

        "docs": [
            {
                "host": "https://host.example.com",
                "ctaSetting": "allow | allow-and-remember | never-allow | default",
                "flashClassification": "unclassified | unknown | allowed | denied",
                "is3rdParty": false,
                "userAction": ["allow", "allow-and-remember", "deny", "page-refreshed", "feedback-given"],
                "ctpVia": "notificationbar | overlay | urlbar-icon | null",
                "docshellId": "{1234-abcd-...}",

                "user-feedback": {
                    "choice": "broken-video | broken-audio | etc..",
                    "problemFixed": "false | true | null",
                    "detail": "free-form string field",
                },

                "flashObjs": [
                    {
                        "path": "https://www.example.org/flash.swf",
                        "classification": "allowed | denied | fallback-used | ctp-overlay | ctp-bar",
                        "is3rdParty": true,
                        "width": 200,
                        "height": 200,
                        "clickedOnOverlay": false,
                    },
                    "..."
                ],

                "subDocs": [" {...} "],

            },
            "...",
        ],

        "counts": {
            "totalDocs": 400,
            "flashDocs": 300,
            
            "flashObjs": {
                "total": 300,
                "fallbacked": 50,
                "allowed": 200,
                "denied": 100,
                "ctp": 50,
            },

            "user-action": {
                "allow": 5,
                "allow-and-remember": 10,
                "never-allow": 10,
                "feedback-given": 1
            },

        }
    }
```


The meaning of each field is detailed below:

`clientId`: The telemetry client id

`mainPing`: The associated telemetry main ping id

`locale`: The user's browser locale

`geo`: The user's geo

`flashVersion`: The version of the Flash plugin installed

`datetime`: The date/time of when this payload was generated. A Unix
    timestamp obtained from Date.now() when the ping is generated.

`profileAge`: The age, in days, of the user's profile

`daysInExperiment`: The number of days that the user has been part of this
    experiment

`experimentGroup`: The current iteration of the experiment for this user. It
    will be used to match which allow/block list version the user is currently
    using, which will be updated roughly weekly. It might also be used to tag
    control users.

`docs`: An array of objects containing information about the pages opened by
    the user. Only pages that contains Flash objects will be included. Pages
    with no flash objects will only show up as an aggregated count in another
    field.

`docs host`: The host of the page. It includes the protocol + the domain.

`docs ctaSetting`: What was the previous CTA setting chosen by the user for
    this page (through the allow, allow-and-remember, never-allow setting).

`docs flashClassification`: The classification of this flash object
    according to the allow/deny lists.

`docs is3rdParty`: whether this document is 1st party/3rd party (only makes
    sense as a subdocument). The definition of a 3rd-party document is one
    where the host is different than the top-level doc.

`docs userAction`: An array of actions the user took on this page (as more
    than one action might have been taken. Valid values are: "allow", "allow-
    and-remember", "deny", "page-refreshed", "feedback-given".

`docs ctpVia`: If the user took an allow/deny action (i.e., making a click-
    to-activate choice), where did he do it: through the CTP overlay, the
    notification bar, or the icon in the url bar. If no action was taken this
    field may be null.

`docs docshellId`: A numeric field that is persistent on a tab. This allows
    us to track an action that generates a new document, e.g. a page-refresh
    or an allow action.

`docs user-feedback`: An object describing the feedback that the user might
    have given about this page through the Shield Study UI. This can be null
    if no feedback was given.

`docs user-feedback choice`: The option chosen about the problem reported,
    in the optionlist. Examples are broken-video, broken-audio, etc.

`docs user-feedback problemFixed`: Whether the problem got fixed by allowing
    Flash to run. Can be true for yes, false for no, or null for not answered.

`docs user-feedback details`: A free-form string field where the user can
    write any details that they want.

`docs subDocs`: An array of subdocuments (iframes) on this document,
    containing the same structure.

`docs flashObjs`: An array of objects describing each SWF object on this
    page.

`docs flashObjs path`: The URL of the SWF object.

`docs flashObjs classification`: The way that the browser decided to display
    this object: As allowed, denied, through the HTML fallback ("fallback-
    used"), or through CTP ("ctp-overlay" or "ctp-bar").

`docs flashObjs is3rdParty`: Whether this SWF is 1st party or 3rd party,
    according to the same rules as described above.

`docs flashObjs width` and `height`: The advertised (not computed)
    width/height of this object.

`docs flashObjs clickedOnOverlay`: If this object was classifed as "ctp-
    overlay" and it led the user to clicking on it, this will be set to true.
    Otherwise false.

`counts`: An aggregated counts object that might facilitate the reports so
    that we don't have to look at every document of every submission to get
    these counts. This data would already be derivable from the previous data
    in the ping (except the *totalDocs* one), but it's nicer to have this
    aggregated count.

`counts totalDocs`: The total number of documents opened by the user while
    this payload was being accumulated.

`counts flashDocs`: The total number of documents that had at least one
    Flash object. Only top-level documents are counted.

`counts flashObjs`: An object with aggregated counts about the details of
    each flash object.

`counts flashObjs total`: Total number of flash objects (<object> or
    <embed>) seen by the user.

`counts flashObjs fallbacked`: Number of Flash objects that used HTML
    fallback.

`counts flashObjs allowed`: Number of Flash objects that were directly
    allowed by the allow list.

`counts flashObjs denied`: Number of Flash objects that were directly denied
    by the deny list.

`counts flashObjs ctp`: All other remaining Flash objects (that weren't
    fallbacked, allowed or denied), will have been ctp'ed.

`counts user-action`: Counts of user actions taken during this payload
    accummulation.

`counts user-action allow`: Number of times the user clicked Allow.

`counts user-action allow-and-remember`: Number of times the user clicked
    Allow and Remember.

`counts user-action never-allow`: Nubmer of times the user clicked Never
    allow.

`counts user-action feedback-given`: Number of times the user provided
    feedback through the study UI.

> **Note**: This data _will_ be collected for Private Browsing windows.
