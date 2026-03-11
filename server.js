import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { activeWindow } from 'get-windows';
import Database from 'better-sqlite3';

let port = 8201;
let public_dir = path.resolve('./public');
let SEC = 1000;
let MIN = 60 * SEC;

let ext_to_content_type = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
};

let env = readEnvFromFile();

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

  // let path_no_slash = req.url.slice(1);
  // if (path_no_slash in api) {
  //   let body = '';
  //   req.on('data', chunk => {
  //     body += chunk.toString();
  //   });
  //   req.on('end', async () => {
  //     let args = JSON.parse(body);
  //     let result = await api[path_no_slash].apply(null, args);
  //     res.writeHead(200, { 'Content-Type': 'application/json' });
  //     res.end(JSON.stringify(result));
  //   });
  // }
  // else {
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
  // }
});

server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

let config_contents = tryReadFileSync('config.json');
let project_ids = [];
if (config_contents) {
  let config = JSON.parse(config_contents);
  for (let cat of config.categories)
    if (cat.daycast_project_id)
      project_ids.push(cat.daycast_project_id);
}

// Daycast DB prep (TODO: auto-manage cross midnight)
let db, last_proj_json, sel_time_bounds, sel_tt_events, sel_tasks;
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


let last_title, stream, filename;
setInterval(async function () {
  // manage heartbeat
  let prev_heartbeat = tryReadFileSync('public/data/heartbeat.txt');
  if (prev_heartbeat) {
    prev_heartbeat = new Date(prev_heartbeat);
    let delta = new Date() - new Date(prev_heartbeat);
    if (delta > 60 * 1000) {
      let heartbeat_logfile = getFilename(prev_heartbeat);
      let line = `${timestamp(prev_heartbeat)} activity tracking stopped\n`;
      if (heartbeat_logfile == filename)
        stream.write(line);
      else
        fs.appendFileSync(heartbeat_logfile, line, {flush: true});
    }
  }
  fs.writeFileSync('public/data/heartbeat.txt', new Date().toISOString(), {flush: true});

  // query Daycast DB & update project-min JSON
  if (db) {
    let dt = new Date();
    // dt.setDate(dt.getDate() - 1);
    let dt_str = toISODate(dt);

    let bounds = sel_time_bounds.get(dt_str);
    let tt_events = sel_tt_events.all(bounds.min_time, bounds.max_time);

    let tasks = sel_tasks.all(dt_str);
    tasks = tasks.map(record => JSON.parse(record.value));
    tasks = tasks.filter(task => project_ids.includes(task.project_id));
    let task_ids = tasks.map(task => task.id);  

    let proj_to_min = {};
    let task_to_ms = getTaskMS(task_ids, tt_events);
    for (let project_id of project_ids) {
      proj_to_min[project_id] = 0;
      for (let task of tasks)
        if (task.project_id == project_id)
          proj_to_min[project_id] += Math.round(task_to_ms[task.id] / MIN);
    }

    let proj_json = JSON.stringify(proj_to_min, null, 2);
    if (proj_json != last_proj_json) {
      fs.writeFileSync(`public/data/${dt_str}-project-min.json`, proj_json, {flush: true});
      last_proj_json = proj_json;
    }
  }

  // update active window log
  let win = await activeWindow();
  let curr_title = win?.title || '';
  if (curr_title != last_title) {
    writeLogLine(`activated: ${curr_title}`);
    last_title = curr_title;
  }
}, 1000);

function writeLogLine(msg) {
  let dt = new Date();
  ensureTodaysLogFile(dt);
  stream.write(`${timestamp(dt)} ${msg}\n`);
}

function ensureTodaysLogFile(dt) {
  let new_filename = getFilename(dt);
  if (new_filename != filename) {
    if (stream)
      stream.end();

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
  for (var task_id in task_ms) {
    task_ms[task_id] = floorMin(task_ms[task_id]);
  }

  return task_ms;
}

// always round down to the nearest minute
// this keeps the behavior as the user expects
// since the user edits & "owns" the data in the UI at the minute granularity
function floorMin(ms) {
  return Math.floor(ms / 60000) * 60000;
}
