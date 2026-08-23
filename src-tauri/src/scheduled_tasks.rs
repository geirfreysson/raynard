use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, TimeZone, Utc, Weekday};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

const STORE_VERSION: u32 = 1;
static ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskSchedule {
    pub frequency: String,
    pub time: String,
    pub time_zone: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day_of_week: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day_of_month: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub month_of_year: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub destination_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination_chat_id: Option<String>,
    pub schedule: TaskSchedule,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
    pub next_run_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_execution_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskDraft {
    pub name: String,
    pub prompt: String,
    pub destination_type: String,
    #[serde(default)]
    pub destination_chat_id: Option<String>,
    pub schedule: TaskSchedule,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledExecution {
    pub execution_id: String,
    pub manual: bool,
    pub scheduled_for: String,
    pub task: ScheduledTask,
}

#[derive(Default, Deserialize, Serialize)]
struct ScheduledTaskStore {
    version: u32,
    tasks: Vec<ScheduledTask>,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn safe_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}",
        Utc::now().timestamp_millis(),
        ID_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn parse_clock(raw: &str) -> Result<(u32, u32), String> {
    let (hour, minute) = raw
        .trim()
        .split_once(':')
        .ok_or_else(|| "Schedule time must use HH:MM.".to_string())?;
    let hour = hour
        .parse::<u32>()
        .map_err(|_| "Schedule hour is invalid.".to_string())?;
    let minute = minute
        .parse::<u32>()
        .map_err(|_| "Schedule minute is invalid.".to_string())?;
    if hour > 23 || minute > 59 {
        return Err("Schedule time must be between 00:00 and 23:59.".to_string());
    }
    Ok((hour, minute))
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    (NaiveDate::from_ymd_opt(next_year, next_month, 1).unwrap() - Duration::days(1)).day()
}

fn weekday_number(day: Weekday) -> u32 {
    day.num_days_from_monday() + 1
}

fn date_matches(schedule: &TaskSchedule, date: NaiveDate) -> bool {
    match schedule.frequency.as_str() {
        "daily" => true,
        "weekly" => schedule.day_of_week == Some(weekday_number(date.weekday())),
        "monthly" => {
            let anchor = schedule.day_of_month.unwrap_or(1).clamp(1, 31);
            date.day() == anchor.min(days_in_month(date.year(), date.month()))
        }
        "quarterly" => {
            let anchor_month = schedule.month_of_year.unwrap_or(1).clamp(1, 12);
            let month_matches = (date.month() + 12 - anchor_month) % 3 == 0;
            let anchor_day = schedule.day_of_month.unwrap_or(1).clamp(1, 31);
            month_matches && date.day() == anchor_day.min(days_in_month(date.year(), date.month()))
        }
        "yearly" => {
            let month = schedule.month_of_year.unwrap_or(1).clamp(1, 12);
            let anchor_day = schedule.day_of_month.unwrap_or(1).clamp(1, 31);
            date.month() == month
                && date.day() == anchor_day.min(days_in_month(date.year(), date.month()))
        }
        _ => false,
    }
}

fn resolve_local(tz: Tz, date: NaiveDate, hour: u32, minute: u32) -> Option<DateTime<Utc>> {
    // A requested wall time can fall in a DST gap. Move forward to the first
    // valid minute; on a repeated wall time, choose the earlier occurrence.
    let mut local = date.and_hms_opt(hour, minute, 0)?;
    for _ in 0..=180 {
        match tz.from_local_datetime(&local) {
            LocalResult::Single(value) => return Some(value.with_timezone(&Utc)),
            LocalResult::Ambiguous(early, _) => return Some(early.with_timezone(&Utc)),
            LocalResult::None => local += Duration::minutes(1),
        }
    }
    None
}

pub fn validate_schedule(schedule: &TaskSchedule) -> Result<(), String> {
    if !matches!(
        schedule.frequency.as_str(),
        "daily" | "weekly" | "monthly" | "quarterly" | "yearly"
    ) {
        return Err("Unsupported schedule frequency.".to_string());
    }
    parse_clock(&schedule.time)?;
    schedule
        .time_zone
        .parse::<Tz>()
        .map_err(|_| "Schedule timezone must be a valid IANA timezone.".to_string())?;
    if schedule.frequency == "weekly" && !matches!(schedule.day_of_week, Some(1..=7)) {
        return Err("Weekly schedules require a weekday from 1 to 7.".to_string());
    }
    if matches!(
        schedule.frequency.as_str(),
        "monthly" | "quarterly" | "yearly"
    ) && !matches!(schedule.day_of_month, Some(1..=31))
    {
        return Err(
            "Monthly, quarterly, and yearly schedules require a day from 1 to 31.".to_string(),
        );
    }
    if matches!(schedule.frequency.as_str(), "quarterly" | "yearly")
        && !matches!(schedule.month_of_year, Some(1..=12))
    {
        return Err("Quarterly and yearly schedules require an anchor month.".to_string());
    }
    Ok(())
}

pub fn next_occurrence(
    schedule: &TaskSchedule,
    after: DateTime<Utc>,
) -> Result<DateTime<Utc>, String> {
    validate_schedule(schedule)?;
    let tz = schedule.time_zone.parse::<Tz>().unwrap();
    let (hour, minute) = parse_clock(&schedule.time)?;
    let local_after = after.with_timezone(&tz);
    let mut date = local_after.date_naive();
    for _ in 0..=370 {
        if date_matches(schedule, date) {
            if let Some(candidate) = resolve_local(tz, date, hour, minute) {
                if candidate > after {
                    return Ok(candidate);
                }
            }
        }
        date = date
            .succ_opt()
            .ok_or_else(|| "Could not advance schedule date.".to_string())?;
    }
    Err("Could not find the next schedule occurrence.".to_string())
}

fn validate_draft(draft: &ScheduledTaskDraft) -> Result<(), String> {
    if draft.name.trim().is_empty() {
        return Err("Task name is required.".to_string());
    }
    if draft.prompt.trim().is_empty() {
        return Err("Task prompt is required.".to_string());
    }
    if draft.destination_type != "newChat" && draft.destination_type != "existingChat" {
        return Err("Destination must be a new or existing chat.".to_string());
    }
    if draft.destination_type == "existingChat"
        && draft
            .destination_chat_id
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
    {
        return Err("An existing-chat destination requires a chat ID.".to_string());
    }
    validate_schedule(&draft.schedule)
}

fn read_store(path: &Path) -> Result<ScheduledTaskStore, String> {
    if !path.is_file() {
        return Ok(ScheduledTaskStore {
            version: STORE_VERSION,
            tasks: Vec::new(),
        });
    }
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Could not read scheduled tasks: {error}"))?;
    let mut store: ScheduledTaskStore = serde_json::from_str(&raw)
        .map_err(|error| format!("Could not parse scheduled tasks: {error}"))?;
    store.version = STORE_VERSION;
    Ok(store)
}

fn write_store(path: &Path, store: &ScheduledTaskStore) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create scheduled task storage: {error}"))?;
    }
    let raw = serde_json::to_vec(store)
        .map_err(|error| format!("Could not serialize scheduled tasks: {error}"))?;
    fs::write(path, raw).map_err(|error| format!("Could not save scheduled tasks: {error}"))
}

pub fn list(path: &Path) -> Result<Vec<ScheduledTask>, String> {
    let mut tasks = read_store(path)?.tasks;
    tasks.sort_by(|left, right| left.next_run_at.cmp(&right.next_run_at));
    Ok(tasks)
}

pub fn create(path: &Path, draft: ScheduledTaskDraft) -> Result<ScheduledTask, String> {
    validate_draft(&draft)?;
    let now = Utc::now();
    let timestamp = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let task = ScheduledTask {
        id: safe_id("task"),
        name: draft.name.trim().chars().take(120).collect(),
        prompt: draft.prompt.trim().to_string(),
        destination_type: draft.destination_type,
        destination_chat_id: draft
            .destination_chat_id
            .filter(|value| !value.trim().is_empty()),
        schedule: draft.schedule.clone(),
        enabled: true,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        next_run_at: next_occurrence(&draft.schedule, now)?
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        last_run_at: None,
        last_status: None,
        last_error: None,
        active_execution_id: None,
    };
    let mut store = read_store(path)?;
    store.tasks.push(task.clone());
    write_store(path, &store)?;
    Ok(task)
}

pub fn update(path: &Path, id: &str, draft: ScheduledTaskDraft) -> Result<ScheduledTask, String> {
    validate_draft(&draft)?;
    let mut store = read_store(path)?;
    let task = store
        .tasks
        .iter_mut()
        .find(|task| task.id == id)
        .ok_or_else(|| "Scheduled task not found.".to_string())?;
    if task.active_execution_id.is_some() {
        return Err("Wait for the running task before editing it.".to_string());
    }
    task.name = draft.name.trim().chars().take(120).collect();
    task.prompt = draft.prompt.trim().to_string();
    task.destination_type = draft.destination_type;
    task.destination_chat_id = draft
        .destination_chat_id
        .filter(|value| !value.trim().is_empty());
    task.schedule = draft.schedule;
    task.updated_at = now_iso();
    task.next_run_at = next_occurrence(&task.schedule, Utc::now())?
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let result = task.clone();
    write_store(path, &store)?;
    Ok(result)
}

pub fn set_enabled(path: &Path, id: &str, enabled: bool) -> Result<ScheduledTask, String> {
    let mut store = read_store(path)?;
    let task = store
        .tasks
        .iter_mut()
        .find(|task| task.id == id)
        .ok_or_else(|| "Scheduled task not found.".to_string())?;
    task.enabled = enabled;
    task.updated_at = now_iso();
    if enabled {
        task.next_run_at = next_occurrence(&task.schedule, Utc::now())?
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    }
    let result = task.clone();
    write_store(path, &store)?;
    Ok(result)
}

pub fn delete(path: &Path, id: &str) -> Result<(), String> {
    let mut store = read_store(path)?;
    if store
        .tasks
        .iter()
        .any(|task| task.id == id && task.active_execution_id.is_some())
    {
        return Err("Wait for the running task before deleting it.".to_string());
    }
    let before = store.tasks.len();
    store.tasks.retain(|task| task.id != id);
    if store.tasks.len() == before {
        return Err("Scheduled task not found.".to_string());
    }
    write_store(path, &store)
}

pub fn due(path: &Path) -> Result<Vec<ScheduledTask>, String> {
    let now = Utc::now();
    Ok(list(path)?
        .into_iter()
        .filter(|task| {
            task.enabled
                && task.active_execution_id.is_none()
                && DateTime::parse_from_rfc3339(&task.next_run_at)
                    .map(|date| date.with_timezone(&Utc) <= now)
                    .unwrap_or(false)
        })
        .collect())
}

pub fn claim(path: &Path, id: &str, manual: bool) -> Result<ScheduledExecution, String> {
    let mut store = read_store(path)?;
    let now = Utc::now();
    let task = store
        .tasks
        .iter_mut()
        .find(|task| task.id == id)
        .ok_or_else(|| "Scheduled task not found.".to_string())?;
    if task.active_execution_id.is_some() {
        return Err("That task is already running.".to_string());
    }
    if !manual {
        if !task.enabled {
            return Err("That task is paused.".to_string());
        }
        let due_at = DateTime::parse_from_rfc3339(&task.next_run_at)
            .map_err(|_| "The task has an invalid next run time.".to_string())?
            .with_timezone(&Utc);
        if due_at > now {
            return Err("That task is not due yet.".to_string());
        }
    }
    let scheduled_for = if manual {
        now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    } else {
        task.next_run_at.clone()
    };
    let execution_id = safe_id("run");
    task.active_execution_id = Some(execution_id.clone());
    task.last_status = Some("running".to_string());
    task.last_error = None;
    task.updated_at = now_iso();
    if !manual {
        task.next_run_at = next_occurrence(&task.schedule, now)?
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    }
    let result = ScheduledExecution {
        execution_id,
        manual,
        scheduled_for,
        task: task.clone(),
    };
    write_store(path, &store)?;
    Ok(result)
}

pub fn complete(
    path: &Path,
    id: &str,
    execution_id: &str,
    status: &str,
    error: Option<String>,
    destination_chat_id: Option<String>,
) -> Result<ScheduledTask, String> {
    let mut store = read_store(path)?;
    let task = store
        .tasks
        .iter_mut()
        .find(|task| task.id == id)
        .ok_or_else(|| "Scheduled task not found.".to_string())?;
    if task.active_execution_id.as_deref() != Some(execution_id) {
        return Err("That scheduled execution is no longer active.".to_string());
    }
    if task.destination_type == "newChat" && task.destination_chat_id.is_none() {
        task.destination_chat_id = destination_chat_id.filter(|value| !value.trim().is_empty());
    }
    task.active_execution_id = None;
    task.last_run_at = Some(now_iso());
    task.last_status = Some(
        if status == "completed" {
            "completed"
        } else {
            "error"
        }
        .to_string(),
    );
    task.last_error = error.filter(|value| !value.trim().is_empty());
    task.updated_at = now_iso();
    let result = task.clone();
    write_store(path, &store)?;
    Ok(result)
}

pub fn assign_destination_chat(
    path: &Path,
    id: &str,
    execution_id: &str,
    chat_id: &str,
) -> Result<ScheduledTask, String> {
    let mut store = read_store(path)?;
    let task = store
        .tasks
        .iter_mut()
        .find(|task| task.id == id)
        .ok_or_else(|| "Scheduled task not found.".to_string())?;
    if task.active_execution_id.as_deref() != Some(execution_id) {
        return Err("That scheduled execution is no longer active.".to_string());
    }
    if task.destination_type != "newChat" {
        return Err("Only a dedicated-chat task can assign its destination.".to_string());
    }
    let chat_id = chat_id.trim();
    if chat_id.is_empty() {
        return Err("Destination chat ID is required.".to_string());
    }
    task.destination_chat_id = Some(chat_id.to_string());
    task.updated_at = now_iso();
    let result = task.clone();
    write_store(path, &store)?;
    Ok(result)
}

pub fn recover_interrupted(path: &Path) -> Result<(), String> {
    let mut store = read_store(path)?;
    let mut changed = false;
    for task in &mut store.tasks {
        if task.active_execution_id.take().is_some() {
            task.last_status = Some("interrupted".to_string());
            task.last_error = Some("Raynard closed before this run completed.".to_string());
            task.updated_at = now_iso();
            changed = true;
        }
    }
    if changed {
        write_store(path, &store)?;
    }
    Ok(())
}

pub fn tasks_targeting_chat(path: &Path, chat_id: &str) -> Result<Vec<String>, String> {
    Ok(list(path)?
        .into_iter()
        .filter(|task| task.destination_chat_id.as_deref() == Some(chat_id))
        .map(|task| task.name)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schedule(frequency: &str, time_zone: &str) -> TaskSchedule {
        TaskSchedule {
            frequency: frequency.to_string(),
            time: "09:00".to_string(),
            time_zone: time_zone.to_string(),
            day_of_week: None,
            day_of_month: None,
            month_of_year: None,
        }
    }

    fn temp_store(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "raynard-scheduled-{label}-{}-{}.json",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ))
    }

    fn draft() -> ScheduledTaskDraft {
        ScheduledTaskDraft {
            name: "Inflation check".to_string(),
            prompt: "Compare Iceland inflation with the OECD.".to_string(),
            destination_type: "newChat".to_string(),
            destination_chat_id: None,
            schedule: schedule("daily", "UTC"),
        }
    }

    #[test]
    fn daily_schedule_preserves_wall_time_across_dst() {
        let input = schedule("daily", "Europe/London");
        let after = "2026-03-28T10:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let next = next_occurrence(&input, after).unwrap();
        assert_eq!(next.to_rfc3339(), "2026-03-29T08:00:00+00:00");
    }

    #[test]
    fn monthly_anchor_clamps_without_drifting() {
        let mut input = schedule("monthly", "UTC");
        input.day_of_month = Some(31);
        let january = "2026-01-31T10:00:00Z".parse::<DateTime<Utc>>().unwrap();
        assert_eq!(next_occurrence(&input, january).unwrap().day(), 28);
        let february = "2026-02-28T10:00:00Z".parse::<DateTime<Utc>>().unwrap();
        assert_eq!(next_occurrence(&input, february).unwrap().day(), 31);
    }

    #[test]
    fn quarterly_schedule_uses_anchor_month() {
        let mut input = schedule("quarterly", "UTC");
        input.day_of_month = Some(15);
        input.month_of_year = Some(2);
        let after = "2026-02-15T10:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let next = next_occurrence(&input, after).unwrap();
        assert_eq!((next.month(), next.day()), (5, 15));
    }

    #[test]
    fn manual_runs_do_not_move_the_recurring_schedule() {
        let path = temp_store("manual");
        let task = create(&path, draft()).unwrap();
        let before = task.next_run_at.clone();
        let execution = claim(&path, &task.id, true).unwrap();
        assert_eq!(execution.task.next_run_at, before);
        let completed = complete(
            &path,
            &task.id,
            &execution.execution_id,
            "completed",
            None,
            Some("chat-task".to_string()),
        )
        .unwrap();
        assert_eq!(completed.destination_chat_id.as_deref(), Some("chat-task"));
        assert_eq!(completed.last_status.as_deref(), Some("completed"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn overdue_occurrences_coalesce_into_one_claim() {
        let path = temp_store("overdue");
        let task = create(&path, draft()).unwrap();
        let mut store = read_store(&path).unwrap();
        store.tasks[0].next_run_at = "2020-01-01T09:00:00Z".to_string();
        write_store(&path, &store).unwrap();

        assert_eq!(due(&path).unwrap().len(), 1);
        let execution = claim(&path, &task.id, false).unwrap();
        assert_eq!(execution.scheduled_for, "2020-01-01T09:00:00Z");
        assert!(DateTime::parse_from_rfc3339(&execution.task.next_run_at).unwrap() > Utc::now());
        assert!(due(&path).unwrap().is_empty());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn startup_marks_an_active_execution_interrupted() {
        let path = temp_store("interrupted");
        let task = create(&path, draft()).unwrap();
        claim(&path, &task.id, true).unwrap();
        recover_interrupted(&path).unwrap();
        let recovered = list(&path).unwrap().remove(0);
        assert_eq!(recovered.active_execution_id, None);
        assert_eq!(recovered.last_status.as_deref(), Some("interrupted"));
        let _ = fs::remove_file(path);
    }
}
