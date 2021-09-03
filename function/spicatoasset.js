/***********************************************************************

What can this asset do?

  -You can create an asset from your spica instance
  -If you want, you can upload this asset to the assetstore and let everyone use it

PROCESS * 
 - Will clone the address of an empty repository you created on git
 - Your project will be converted into an asset and sent to your repository

NOTES * 

 -Remember to set environment variables first (Don't remove _IGNORE_ variable, because this function will be ignored when conversion)
 -If you want to run it a second time, first clean your repository 
 -You must raise the function maximum timeout up to 300 seconds from the Hq dashboard panel (advance settings)


OPTIONAL PARAMS *

  If you don't want to all buckets or all functions , you can give parameters the body in this way
  - {
    "unwanted_buckets": "bucket_id,bucket_id",
    "unwanted_functions": "function_id"
    }
/************************************************************************/

import * as Bucket from "@spica-devkit/bucket";
const fetch = require("node-fetch");
var YAML = require("yaml");
import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";

let GIT_USERNAME = process.env.GIT_USERNAME;
let GIT_EMAIL = process.env.GIT_EMAIL;
let GIT_REPO_NAME = process.env.GIT_REPO_NAME;
let GIT_ACCESS_TOKEN = process.env.GIT_ACCESS_TOKEN;
let GIT_URL = process.env.GIT_URL;

export async function convertAsset(req, res) {
    Bucket.initialize({ apikey: `${process.env.API_KEY}` });
    const { unwanted_buckets, unwanted_functions } = req.body;

    const HOST = req.headers.get("host");
    /////////--------------Get Schemas-----------------////////////
    let schemas = await Bucket.getAll().catch(error =>
        console.log("get allBuckets error :", error)
    );
    /////////--------------Get Schemas-----------------////////////

    /////////--------------Get Functions with dependencies and environments-----------------////////////
    let allFunctions = await getAllFunctions(HOST).catch(error =>
        console.log("get allfunctions error :", error)
    );

    for (const fn of allFunctions) {
        await getIndexes(fn._id, HOST)
            .then(indexData => {
                fn.index = indexData.index;
            })
            .catch(error => console.log("getIndexes error :", error));
        await getDependencies(fn._id, HOST)
            .then(dependency => {
                fn.dependencies = dependency;
            })
            .catch(error => console.log("getDependencies error :", error));
    }
    /////////--------------Get Functions with dependencies and environments-----------------////////////

    let data = {
        schemas: schemas,
        allFunctions: allFunctions
    };

    let yamlString = "";
    let schemaFindArr = [];
    data.schemas = data.schemas.filter((s, i) => {
        setUnrealArray(s, i);
        if (unwanted_buckets) {
            return !unwanted_buckets.includes(s._id);
        }
        return true;
    });
    if (unwanted_functions) {
        data.allFunctions = data.allFunctions.filter(f => {
            if (unwanted_functions) {
                return !unwanted_functions.includes(f._id);
            }
            return true;
        });
    }
    let dubRelation = false;

    let changeObj = [];
    data.schemas = data.schemas.map((s, i) => {
        s = {
            apiVersion: "bucket/v1",
            kind: "Schema",
            metadata: {
                name: doUnreal(s.title, i)
            },
            spec: s
        };
        Object.keys(s.spec.properties).forEach(p => {
            delete s.spec.properties[p].title;
            if (s.spec.properties[p].type == "relation") {
                let indexLast = s.metadata.name;
                let indexFirst = schemaFindArr.filter(
                    fs => fs._id == s.spec.properties[p].bucketId
                )[0].unrealName;
                if (!changeObj.some(o => o.last == indexLast && o.first == indexFirst)) {
                    changeObj.push({ last: indexLast, first: indexFirst });
                    if (
                        changeObj.some(o => o.last == indexFirst && o.first == indexLast) &&
                        !dubRelation
                    ) {
                        dubRelation = true;
                    }
                }
                s.spec.properties[p].bucket = {
                    resourceFieldRef: {
                        schemaName: schemaFindArr.filter(
                            f => f._id == s.spec.properties[p].bucketId
                        )[0].unrealName
                    }
                };
                delete s.spec.properties[p].bucketId;
            }
        });
        delete s.spec._id;
        //  delete s.spec.title
        return s;
    });
    changeObj.forEach(c => {
        let firstIndex = data.schemas.findIndex(f => f.metadata.name == c.first);
        let lastIndex = data.schemas.findIndex(f => f.metadata.name == c.last);
        if (firstIndex > lastIndex) {
            let temp = data.schemas.splice(firstIndex, 1);
            data.schemas.unshift(temp[0]);
        }
    });

    function setUnrealArray(s, i) {
        let data = {
            _id: s._id,
            unrealName: doUnreal(s.title, i),
            realName: s.title
        };
        schemaFindArr.push(data);
    }

    function doUnreal(word, i) {
        // console.log(word);
        word =
            word
                .trim()
                .replace(/ /g, "-")
                .toLowerCase() +
            "-" +
            (i + 1);
        return word;
    }
    data.schemas.forEach(s => {
        yamlString += "# BUCKET - " + s.spec.title + "\n" + YAML.stringify(s) + "---\n";
    });
    let triggers = [];
    let indexes = [];
    let envs = [];
    let isIgnore = false;
    let willSpliceIndex;
    // console.log(JSON.stringify(data.allFunctions, null, 4));
    data.allFunctions.forEach((f, i) => {
        console.log(JSON.stringify(f, null, 4));
        envs = [];
        let unrealname = doUnreal(f.name, i);
        Object.keys(f.env).forEach(e => {
            if (e == "_IGNORE_") isIgnore = true;
            envs.push({ name: e, value: f.env[e] });
        });
        if (envs.length > 0) f.environment = envs;
        delete f.env;
        console.log("isIgnore", isIgnore, f.name);
        if (isIgnore) {
            willSpliceIndex = i;
            isIgnore = false;
            return;
        }
        if (f.dependencies) {
            f.dependency = f.dependencies;
            delete f.dependencies;
        }
        f.title = f.name;
        if (f.language == "javascript") {
            f.code = "./function/" + unrealname + ".js";
            f.runtime = {
                name: "Node",
                language: "Javascript"
            };
        }
        if (f.language == "typescript") {
            f.code = "./function/" + unrealname + ".ts";
            f.runtime = {
                name: "Node",
                language: "Typescript"
            };
        }
        indexes.push({ func: unrealname + ".js", index: f.index });
        delete f.index;
        delete f.memoryLimit;
        f = {
            apiVersion: "function/v1",
            kind: "Function",
            metadata: {
                name: unrealname
            },
            spec: f
        };

        Object.keys(f.spec.triggers).forEach(t => {
            f.spec.triggers[t].name = t;
            f.spec.triggers[t].func = f.metadata.name;
            triggers.push(f.spec.triggers[t]);
        });
        delete f.spec._id;
        delete f.spec.name;
        delete f.spec.triggers;
        yamlString += "# FUNCTION - " + f.spec.title + "\n" + YAML.stringify(f) + "---\n";
        return f;
    });

    data.allFunctions.splice(willSpliceIndex, 1);

    triggers = triggers.map(t => {
        switch (t.type) {
            case "bucket":
                t.bucketOptions = {
                    bucket: {
                        resourceFieldRef: {
                            schemaName: schemaFindArr.filter(s => s._id == t.options.bucket)[0]
                                .unrealName
                        }
                    },
                    type: t.options.type
                };
                break;
            case "http":
                delete t.options.preflight;
                t.httpOptions = t.options;
                break;
            case "database":
                t.databaseOptions = t.options;
                break;
        }
        t = {
            apiVersion: "function/v1",
            kind: "Trigger",
            metadata: {
                name: t.name
            },
            spec: t
        };
        delete t.spec.options;
        yamlString += "# TRIGGER - " + t.spec.name + "\n" + YAML.stringify(t) + "---\n";
        return t;
    });
    yamlString = yamlString.substring(0, yamlString.length - 5);
    if (dubRelation) return res.status(400).send({ message: "Cross relation error !" });

    /***********************GIT************************/
    await run("rm", ["-rf", "tmp/repo"]).catch(e => console.log("e :", e));

    await installGit();

    cp.execSync(`git config --global http.sslverify false`, {
        stdio: ["ignore", "ignore", "inherit"]
    });
    cp.execSync(`git config --global user.email ${GIT_EMAIL}`, {
        stdio: ["ignore", "ignore", "inherit"]
    });
    cp.execSync(`git config --global user.name ${GIT_USERNAME}`, {
        stdio: ["ignore", "ignore", "inherit"]
    });

    cp.exec(`git config --list`, (error, stdout, stderr) => {
        if (error) {
            console.error(`git config --list error: ${error.message}`);
            return;
        }
        if (stderr) {
            console.error(`git config --list stderr: ${stderr}`);
            return;
        }
        console.log(`git config --list stdout:\n${stdout}`);
    });

    await run("git", ["clone", `${GIT_URL}`, "tmp/repo"])
        .then(() => {})
        .catch(error => {
            console.log("error : ", error);
            res.status(400).send({
                message: "Cannot find asset documents",
                error: error
            });
        });

    cp.exec(
        `git remote add origin https://${GIT_ACCESS_TOKEN}@github.com/${GIT_USERNAME}/${GIT_REPO_NAME}`,
        { cwd: __dirname + "/tmp/repo" },
        (error, stdout, stderr) => {
            if (error) {
                console.error(`git remote add origin: ${error.message}`);
                return;
            }
            if (stderr) {
                console.error(`git remote set-url stderr: ${stderr}`);
                return;
            }
            console.log(`git remote set-url stdout:\n${stdout}`);
        }
    );

    cp.exec(
        `git remote set-url origin https://${GIT_ACCESS_TOKEN}@github.com/${GIT_USERNAME}/${GIT_REPO_NAME}`,
        { cwd: __dirname + "/tmp/repo" },
        (error, stdout, stderr) => {
            if (error) {
                console.error(`git remote set-url error: ${error.message}`);
                return;
            }
            if (stderr) {
                console.error(`git remote set-url stderr: ${stderr}`);
                return;
            }
            console.log(`git remote set-url stdout:\n${stdout}`);
        }
    );
    const yamlPath = path.join("/tmp/repo", "asset.yaml");
    fs.writeFileSync(__dirname + yamlPath, yamlString);
    let funcPath;
    const funcDir = "./tmp/repo/function";
    if (!fs.existsSync(funcDir)) {
        fs.mkdirSync(funcDir);
    }
    for (let funcIndex of indexes) {
        funcPath = path.join("/tmp/repo/function", funcIndex.func);
        fs.writeFileSync(__dirname + funcPath, funcIndex.index);
    }

    cp.exec("git add --all", { cwd: __dirname + "/tmp/repo" }, (error, stdout, stderr) => {
        if (error) {
            console.error(`git add error: ${error.message}`);
            return;
        }
        if (stderr) {
            console.error(`git add stderr: ${stderr}`);
            return;
        }
        console.log(`git add stdout:\n${stdout}`);
    });
    cp.exec("git commit -m 'spica'", { cwd: __dirname + "/tmp/repo" }, (error, stdout, stderr) => {
        if (error) {
            console.error(`git commit error: ${error.message}`);
            return;
        }
        if (stderr) {
            console.error(`git commit stderr: ${stderr}`);
            return;
        }
        console.log(`git commit stdout:\n${stdout}`);
    });
    cp.exec(
        "git push origin --force",
        { cwd: __dirname + "/tmp/repo" },
        (error, stdout, stderr) => {
            if (error) {
                console.error(`git push error: ${error.message}`);
                return;
            }
            if (stderr) {
                console.error(`git push stderr: ${stderr}`);
                return;
            }
            console.log(`git push stdout:\n${stdout}`);
        }
    );
    cp.exec("rm -rf tmp/repo/.git/*.lock", (error, stdout, stderr) => {
        if (error) {
            console.error(`git remove index error: ${error.message}`);
            return;
        }
        if (stderr) {
            console.error(`git remove index stderr: ${stderr}`);
            return;
        }
        console.log(`git remove index stdout:\n${stdout}`);
    });
    /***********************GIT************************/
    return { yamlString };
}
async function installGit() {
    console.log("INSTALLATION GIT START");
    const script = `apt-get update -y 
    apt-get install git -y`;

    const scriptPath = "/tmp/installDependencies.sh";
    fs.writeFileSync(scriptPath, script);
    fs.chmodSync(scriptPath, "755");
    cp.spawnSync(scriptPath, [], {
        env: {},
        cwd: "/tmp",
        stdio: ["ignore", "inherit", "inherit"]
    });

    console.log("installed");

    return {};
}

function run(binary, args) {
    const proc = cp.spawn(binary, args, { stdio: "inherit" });
    return new Promise((resolve, reject) => {
        proc.once("exit", code => {
            if (code != 0) {
                reject(
                    new Error(
                        `process ${proc.pid} with args (${args.join(
                            " "
                        )}) has quit with non-zero exit code. ${code}`
                    )
                );
            } else {
                resolve();
            }
        });
    });
}

async function getAllFunctions(HOST) {
    return new Promise(async (resolve, reject) => {
        await fetch(`https://${HOST}/api/function/`, {
            headers: {
                Authorization: `APIKEY ${process.env.API_KEY}`
            }
        })
            .then(res => res.json())
            .then(async json => {
                resolve(json);
            })
            .catch(error => {
                reject(error);
                console.log("error : ", error);
            });
    });
}
async function getIndexes(id, HOST) {
    return new Promise(async (resolve, reject) => {
        await fetch(`https://${HOST}/api/function/${id}/index`, {
            headers: {
                Authorization: `APIKEY ${process.env.API_KEY}`
            }
        })
            .then(res => res.json())
            .then(async json => {
                resolve(json);
            })
            .catch(error => {
                reject(error);
                console.log("error : ", error);
            });
    });
}
async function getDependencies(id, HOST) {
    return new Promise(async (resolve, reject) => {
        await fetch(`https://${HOST}/api/function/${id}/dependencies`, {
            headers: {
                Authorization: `APIKEY ${process.env.API_KEY}`
            }
        })
            .then(res => res.json())
            .then(async json => {
                resolve(json);
            })
            .catch(error => {
                reject(error);
                console.log("error : ", error);
            });
    });
}
