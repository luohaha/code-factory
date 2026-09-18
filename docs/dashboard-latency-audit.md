# Dashboard perceived-latency audit

Date: 2026-09-18

## Method and baseline

The audit traces every user action from its synchronous UI state change, through HTTP acceptance, to the SSE event that establishes cross-window consistency. Request counts come from the Dashboard call graph before this change: a workspace reload issued eight parallel GET requests (`workspace`, `configuration`, `agent-models`, `requirements`, `runs`, `pull-requests`, `review-requests`, and `timers`). Counts below exclude the long-lived SSE connection and background Run duration. A range means React could collapse two adjacent message revisions into one fetch.

The optimized path uses these rules:

- show the existing submitting/busy state synchronously;
- apply the mutation response as soon as it arrives;
- idempotently apply persisted resources carried by SSE;
- use a resource-scoped compatibility GET only when an older/incomplete event lacks its resource;
- merge equal-scope fallback refreshes in a 50 ms window;
- keep the eight-GET snapshot only for initial connection and explicit manual refresh.

## Interaction and request sequence

| Interaction | Before: acceptance/final consistency | Finding | After: acceptance/final consistency |
| --- | --- | --- | --- |
| Initial connection | default URL opened SSE and started 8 GETs before the saved/embedded URL effect ran; a different resolved URL repeated both | Embedded or custom endpoints could briefly create two SSE connections and 16 reads | resolve and validate the endpoint first → one SSE connection + one eight-GET initial snapshot |
| Create Requirement | submitting → `POST` → 8 GET action reload; `requirement.created` could add another 8 GET; selection waited for the action reload | 16 unrelated reads delayed opening a resource already returned by `POST` | submitting → `POST` returning Requirement → local upsert and open; SSE repeats the same idempotent upsert; 0 follow-up GET |
| Open Requirement | select card → detail rendered → one messages GET | Previous Requirement messages could render for one frame before the effect started; already loaded workspace resources were sufficient | selection immediately shows a Requirement-bound loading state → one messages GET; responses and SSE messages are ownership-checked and merged by ID/sequence, including messages received while that initial GET is in flight |
| Start / retry | busy → optional attachment POSTs → start POST → 8 GET action reload + one messages GET; `message.created` and `run.started` added 3–4 targeted GETs | 11–13 follow-up GETs; composer completion waited for unrelated workspace data | busy → parallel attachment POSTs → start POST returning Requirement, active Run, and optional Message → local merge; SSE is idempotent; 0 follow-up GET |
| Reply while running | busy → optional uploads → reply POST response updated message/card; `message.created` added Requirement + messages GET | Response was already sufficient, but SSE duplicated two reads | response merges Requirement and Message; SSE deduplicates the same Message; 0 follow-up GET |
| Reply while idle/done | reply POST plus 2 GET from `message.created` and 2 GET from `run.started` | Reactivation/start state arrived through multiple reads and could race the response | response renders persisted reply/reactivated Requirement; `run.started` carries Run/Requirement; 0 follow-up GET |
| Interrupt | busy → interrupt POST → 8 GET + messages GET; later `run.cancelled` caused another 8 GET | 17 follow-up GETs around a single Requirement; acceptance and final process exit were conflated | busy/disabled state remains visible from POST acceptance through the terminal Run event; `run.cancelled` carries final Run/Requirement; 0 follow-up GET; pending-message auto-resume semantics are unchanged |
| Confirm | busy → confirm POST → 8 GET + messages GET; synchronous `requirement.completed` caused another 8 GET | 17 follow-up GETs and unrelated resources delayed the DONE card | confirm response updates Requirement; event supplies Requirement and cancelled Timers for other windows; 0 follow-up GET |
| Attachment upload | local preview → N parallel upload POSTs → parent Start/Reply chain | Upload itself had immediate preview/progress blocking, but inherited the parent's reload fan-out | local preview and busy state remain; N uploads stay parallel; returned attachment IDs feed Start/Reply; no attachment-list query and no unrelated reload |
| Timer create/cancel | busy → mutation response → 8 GET + messages GET; `timer.*` caused another 8 GET | 17 follow-up GETs for one Timer | response upserts one Timer; SSE upserts by ID/update time; 0 follow-up GET |
| Timer fire | `message.created` caused 2 GET, `timer.fired` caused 8 GET, and an idle `run.started` caused 2 GET | A high-frequency trigger could issue 12 reads | Message, Timer, Requirement, and Run payloads update locally; 0 follow-up GET |
| PR Review request | submitting → POST → 8 GET; `review_request.started` caused another 8 GET | 16 reads before review state was stable | POST returns persisted ReviewRequest and Reviewer Run; SSE upserts them; 0 follow-up GET |
| Reviewer completion | `message.created` 2 GET + `run.*` 8 GET; RD wake-up could add 2 GET | A single result fanned out into 10–12 reads | outcome carries ReviewRequest/Run/Requirement and message carries Message/Requirement; RD wake-up carries its Run; 0 follow-up GET |
| PR reconciliation | every `pull_request.*` caused 8 GET; related trigger message/run events added more | Poll-driven bursts repeatedly reloaded unrelated boards | PR payload upsert plus message/run payload upserts; 0 follow-up GET |
| Search | one debounced search GET per query, plus another whenever any reload changed `lastSynced` | Unrelated Timer/config/run activity retriggered the same search | one 200 ms-debounced GET per query; only Requirement/Message/PR index mutations invalidate it; burst invalidations collapse safely |
| Board switch | local state only; 0 requests | No latency issue found | unchanged; 0 requests |
| Settings save | PATCH response updated dialog; `manager.configuration.updated` caused 8 GET | Cross-window sync reloaded all boards | PATCH response updates the current window; SSE carries the complete configuration snapshot; 0 follow-up GET |
| Model catalog refresh | `agent_models.updated` caused 8 GET | A catalog-only event refreshed the workspace | event carries the complete model catalog; 0 follow-up GET |

## Consistency and failure behavior

- Requirement merges compare both Requirement and Session update times. Run merges prefer `finishedAt` over an older running snapshot; PR, ReviewRequest, and Timer merges use their durable update/finish times.
- Message merges use ID plus Requirement-local sequence, so an HTTP echo and its replayed SSE event remain one ordered item.
- Targeted responses and SSE payloads are checked against their Requirement or PR scope. Rows from another Requirement are discarded.
- A full or Requirement-scoped snapshot that finishes after a newer SSE event is merged rather than blindly replacing live state. Requirement deletion/purge IDs remain tombstoned during that race, so older Requirement, Run, Message, PR, Review, or Timer responses cannot resurrect removed state.
- Native EventSource `Last-Event-ID` replay remains unchanged. Resource upserts are idempotent, and incomplete legacy events use precise fallback queries. The 50 ms fallback batch combines only matching scope keys; different Requirement IDs remain separate.
- Upload/reply errors keep editor text and draft attachments for retry. HTTP/SSE failures still surface the existing connection and operation errors. Server-side message sequence, active-Run exclusion, delivery cursors, queued replies, interrupt behavior, and Reviewer-to-RD delivery are unchanged.

## Regression evidence

Dashboard state tests cover stale-response rejection, completed-Run preservation, cross-Requirement row rejection, precise legacy-event routing, zero-read routing for resource-bearing common events, and burst coalescing without scope mixing. Agent Manager tests cover resource-bearing Requirement, Message, Run, Review, purge, and action-response contracts. The repository check results are recorded in the implementation handoff.
