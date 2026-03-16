import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {WebSocketServer} from 'ws';

import { activeWindow } from 'get-windows';
import Database from 'better-sqlite3';

// TODO:
// * load time from today on startup into the local array of log lines
// * adjust it so that it shows % for your current task primarily, w/ total % in parens
// * fade out UI if the websocket connection is broken
// * attempt to auto-reconnect

let port = 8201;
let public_dir = path.resolve('./public');
let SEC = 1000;
let timestamp_re = /^(\d\d):(\d\d):(\d\d) /;
let env = readEnvFromFile();
let ext_to_content_type = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
};

// startup http/websocket server
const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);

  let req_path = './public' + req.url;
  if (!path.resolve(req_path).startsWith(public_dir)) {
    res.writeHead(401, {'Content-Type': 'text/plain'});
    res.end('401 Illegal path');
  }

  // default root to /index.html
  if (req.url == '/')
    req_path = './public/index.html';

  // determine content type
  const ext = path.extname(req_path);
  let content_type = ext_to_content_type[ext] || 'text/html';

  fs.readFile(req_path, (err, content) => {
    if (err) {
      if (err.code == 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500);
        res.end(`Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, {'Content-Type': content_type});
      res.end(content, 'utf-8');
    }
  });
});

const wss = new WebSocketServer({server});
wss.on('connection', function connection(ws) {
  console.log('client connected, setting is_alive: true');
  ws.is_alive = true;
  ws.on('error', console.error);
  ws.on('message', function(evt) {
    ws.is_alive = true;
  });
});
server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

// hydrate config
let config_contents = tryReadFileSync('public/config.json');
let project_ids = [];
assert(config_contents);
let config = JSON.parse(config_contents);
let categories = config.categories;
for (let cat of categories) {
  cat.patterns = cat.patterns.map(str => new RegExp(str, 'i'));
  if (cat.daycast_project_id)
    project_ids.push(cat.daycast_project_id);
}
let unknown_cat = {name: 'unknown'};
let infer_prev_cat_patterns = config.infer_previous_category.patterns.map(str => new RegExp(str, 'i'));

// connect to Daycast DB and setup prepared statements
let db, proj_to_ms, sel_time_bounds, sel_tt_events, sel_tasks;
if (env.DAYCAST_DATA_DIR && project_ids.length) {
  db = openDaycastDB(env.DAYCAST_DATA_DIR);
  // adapted from daycast's time-report.js
  sel_time_bounds = db.prepare(`SELECT MIN(tt_event.timestamp) as min_time, MAX(tt_event.timestamp) as max_time
    FROM tt_event
    INNER JOIN task ON tt_event.task_id = task.id
    WHERE task.deleted=0 AND task.date=?`);
  sel_tt_events = db.prepare(`SELECT task_id, timestamp, type, value FROM tt_event WHERE deleted=0 AND timestamp >= ? AND timestamp <= ?`);
  sel_tasks = db.prepare(`SELECT value FROM task WHERE deleted=0 AND date=?`);
}

let last_title, stream, todays_log, filename;
ensureTodaysLogFile();
todays_log = fs.readFileSync(getFilename(), {encoding: 'utf8'}).split('\n');

// update every 5 seconds
let update_interval = 5 * SEC;
setInterval(async function () {

  // regularly save "heartbeat" to a file, so we know when the computer is asleep
  let prev_heartbeat = tryReadFileSync('public/data/heartbeat.txt');
  if (prev_heartbeat) {
    prev_heartbeat = new Date(prev_heartbeat);
    let delta = new Date() - new Date(prev_heartbeat);
    // if there's more than a 60s gap between heartbeats, flag the last one as an end of activity tracking
    if (delta > 60 * 1000) {
      let heartbeat_logfile = getFilename(prev_heartbeat);
      let line = `${timestamp(prev_heartbeat)} activity tracking stopped\n`;
      if (heartbeat_logfile == filename) {
        stream.write(line);
        todays_log.push(line.trim());
      } else {
        fs.appendFileSync(heartbeat_logfile, line, {flush: true});
      }
    }
  }
  fs.writeFileSync('public/data/heartbeat.txt', new Date().toISOString(), {flush: true});

  // query Daycast DB for clocked time
  if (db) {
    let dt = new Date();
    let dt_str = toISODate(dt);

    let bounds = sel_time_bounds.get(dt_str);
    let tt_events = sel_tt_events.all(bounds.min_time, bounds.max_time);

    let tasks = sel_tasks.all(dt_str);
    tasks = tasks.map(record => JSON.parse(record.value));
    tasks = tasks.filter(task => project_ids.includes(task.project_id));
    let task_ids = tasks.map(task => task.id);  

    proj_to_ms = {};
    let task_to_ms = getTaskMS(task_ids, tt_events);
    for (let project_id of project_ids) {
      proj_to_ms[project_id] = 0;
      for (let task of tasks)
        if (task.project_id == project_id)
          proj_to_ms[project_id] += task_to_ms[task.id];
    }
  }

  // update active window log
  let win = await activeWindow();
  let curr_title = win?.title || '';
  if (curr_title != last_title) {
    writeLogLine(`activated: ${curr_title}`);
    last_title = curr_title;
  }

  // get the focus % for today
  let bins = groupIntoBins(todays_log);
  let pct, clocked_ms;
  for (let cat of categories) {
    if (cat.daycast_project_id) {
      clocked_ms = proj_to_ms[cat.daycast_project_id];

      let tracked_ms = 0;
      for (let bin of bins)
        if (bin.cat == cat)
          tracked_ms += bin.duration;
      
      // TODO: show individual clocked times & total; show tracked time & total
      if (clocked_ms) {
        pct = Math.round(tracked_ms / clocked_ms * 100);
        // console.log(`${cat.name} focus: ${pct}% of ${clocked_ms/MIN} clocked minutes`);
      }
    }
  }

  // send the current pct time & clocked_ms to websocket clients
  for (let ws of wss.clients) {
    if (ws.is_alive) {
      // console.log('sending ping & setting is_alive: false');
      ws.is_alive = false;
      let msg = {evt: 'ping'};
      if (pct || clocked_ms) {
        msg.pct = pct || 0;
        msg.clocked_ms = clocked_ms || 0;
      }
      ws.send(JSON.stringify(msg));
    }
    else {
      console.log('is_alive is false, terminating');
      ws.terminate();
    }
  }
}, update_interval);

function writeLogLine(msg) {
  ensureTodaysLogFile();
  let dt = new Date();
  stream.write(`${timestamp(dt)} ${msg}\n`);
  todays_log.push(`${timestamp(dt)} ${msg}`);
}

function ensureTodaysLogFile() {
  let new_filename = getFilename();
  if (new_filename != filename) {
    if (stream)
      stream.end();
    todays_log = [];

    filename = new_filename;
    stream = fs.createWriteStream(filename, {flags:'a+', flush: true});
  }
}

function readEnvFromFile() {
  let env = {};
  let env_contents = tryReadFileSync('.env');
  if (env_contents) {
    for (let line of env_contents.trim().split('\n')) {
      let parts = line.trim().split('=');
      assert(parts.length == 2, `Too many/few "=" in .env line: "${line.trim()}"`);
      env[parts[0].trim()] = parts[1].trim();
    }
  }
  return env;
}

function tryReadFileSync(filename) {
  try {
    return fs.readFileSync(filename, {encoding: 'utf8', })
  }
  catch(err) {
    if (err.code != 'ENOENT')
      throw err;
  }
}

function openDaycastDB() {
  let files = fs.readdirSync(env.DAYCAST_DATA_DIR);

  let account_db_re = /accounts_([a-f0-9-]+).db/;
  let person_db_re = /person_([a-f0-9-]+).db/;
  let person_id, account_id;
  for (let filename of files) {
    if (!person_id)
      person_id = person_db_re.exec(filename)?.[1];
    if (!account_id)
      account_id = account_db_re.exec(filename)?.[1];
  }

  assert(person_id, `Did not find person DB ("person_{uuid}.db") in "${env.DAYCAST_DATA_DIR}"`);
  assert(account_id, `Did not find account DB ("accounts_{uuid}.db") in "${env.DAYCAST_DATA_DIR}"`);
  return new Database(`${env.DAYCAST_DATA_DIR}/accounts_${account_id}_tasks_${person_id}.db`);
}

function getFilename(dt) {
  if (!dt)
    dt = new Date();
  return `public/data/${toISODate(dt)}-activity.log`;
}

function toISODate(dt) {
  if (!dt)
    dt = new Date();
  return `${dt.getFullYear()}-${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())}`;
}

function timestamp(dt) {
  return `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`;
}

function pad2(n) {
  if (n < 10)
    return "0" + n;
  else
    return n;
}

// adapted from Daycast codebase

// returns accrued time (in ms) for each task
// {task_id_1: 60000, task_id_2: 120000, task_id_3: 240000}
// rounds down (floor), so it doesn't "tick" to 1min until after a full 60 seconds

// NOTE: tt_events must be an array of tt_event objects, sorted by timestamp (ascending)
// including ALL tasks for the user, even finalized tasks
// starting at the earliest timestamp w/ a relevant task_id
// ending at the latest timestamp w/ a relevant task_id
// UNLESS the latest clock-in/out is a clock-in, in which case, keep going until
// the next clock-in, if there is one
function getTaskMS(task_ids, tt_events, cutoff_time) {
  // initialize data w/ 0 ms for each task
  let task_ms = {};
  for (let task_id of task_ids) {
    task_ms[task_id] = 0;
  }

  let clock_in_task_id;
  let clock_in_timestamp;
  for (let tt_evt of tt_events) {
    let task_id = tt_evt.task_id;
    let timestamp = tt_evt.timestamp;

    if (tt_evt.type == 'clock-in') {
      // implicit clock-out when you clock into another task
      if (clock_in_task_id && clock_in_task_id in task_ms)
        task_ms[clock_in_task_id] += timestamp - clock_in_timestamp;

      clock_in_task_id = task_id;
      clock_in_timestamp = timestamp;
    } else if (tt_evt.type == 'clock-out' && task_id in task_ms) {
      // ignore clock-outs unless they're for the most recent clock-in task ID
      if (task_id in task_ms && task_id == clock_in_task_id) {
        task_ms[task_id] += timestamp - clock_in_timestamp;
        clock_in_task_id = clock_in_timestamp = null;
      }
    } else if (tt_evt.type == 'reset' && task_id in task_ms) {
      let value = JSON.parse(tt_evt.value).value;
      if (clock_in_task_id == task_id) {
        task_ms[task_id] = 0;
        clock_in_timestamp = timestamp - value;
      } else {
        task_ms[task_id] = value;
      }
    }
  }

  // if the user is still clocked in, include the still-being-clocked time
  if (clock_in_task_id && clock_in_task_id in task_ms) {
    if (cutoff_time) task_ms[clock_in_task_id] += cutoff_time - clock_in_timestamp;
    else task_ms[clock_in_task_id] += Date.now() - clock_in_timestamp;
  }

  // do the minute floor()ing *after* aggregating for each task
  // we cannot do this at a larger granularity than the task
  // but we should not do it at a smaller granularity (on every clockout) or users unnecessarily lose time
  // for (var task_id in task_ms) {
  //   task_ms[task_id] = floorMin(task_ms[task_id]);
  // }

  return task_ms;
}

// always round down to the nearest minute
// this keeps the behavior as the user expects
// since the user edits & "owns" the data in the UI at the minute granularity
function floorMin(ms) {
  return Math.floor(ms / 60000) * 60000;
}

// categorize
function groupIntoBins(lines) {
  let bins = [];
  let curr_bin, prev_bin;
  for (let line of lines) {
    if (!line)
      continue;

    if (line.endsWith('activity tracking stopped')) {
      if (curr_bin)
        curr_bin.end = parseTimestamp(line);
      continue;
    }

    let cat = getCategory(line);
    if (cat == unknown_cat && matchesPattern(line, infer_prev_cat_patterns)) {
      if (curr_bin?.cat == unknown_cat)
        cat = prev_bin?.cat || unknown_cat;
      else
        cat = curr_bin?.cat || unknown_cat;
    }

    if (cat == curr_bin?.cat && !curr_bin?.end) {
      curr_bin.lines.push(line);
    }
    else {
      prev_bin = curr_bin;
      curr_bin = {cat: cat, lines: [line], start: parseTimestamp(line)};
      
      // implicitly end the previous bin if it didn't explicitly end
      if (prev_bin && !prev_bin.end)
        prev_bin.end = curr_bin.start;

      bins.push(curr_bin);
    }
  }

  // implicitly end the final bin now
  let last_bin = bins[bins.length-1];
  if (last_bin && !last_bin.end)
    last_bin.end = new Date();

  for (let bin of bins) {
    bin.duration = bin.end - bin.start;
  }
  return bins;
}

function parseTimestamp(line) {
  let match = timestamp_re.exec(line);
  assert(match, `line didn't begin with timestamp: ${line}`);
  // let dt = new Date(view_day.toISOString());
  let dt = new Date(); // TODO: this assumes the timestamp is for today... is this safe in a server context?
  dt.setHours(parseInt(match[1]));
  dt.setMinutes(parseInt(match[2]));
  dt.setSeconds(parseInt(match[3]));
  dt.setMilliseconds(0);
  return dt;
}

function getCategory(line) {
  let curr_cat;
  for (let cat of categories) {
    if (matchesPattern(line, cat.patterns)) {
      if (curr_cat) {
        if (curr_cat.is_secondary)
          curr_cat = cat;
        else
          assert(cat.is_secondary, `line matches multiple primary categories: ${curr_cat?.name} and ${cat.name} (${line})`);
      }
      else {
        curr_cat = cat;
      }
    }
  }
  return curr_cat || unknown_cat;
}

function matchesPattern(line, patterns) {
  for (let pattern of patterns) {
    if (pattern.test(line)) {
      return true;
    }
  }
  return false;
}
