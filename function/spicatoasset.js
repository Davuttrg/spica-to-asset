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
import { database, ObjectId } from "@spica-devkit/database";

import fetch from 'node-fetch';
var YAML = require("yaml");
import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";

const PUBLIC_URL = process.env.__INTERNAL__SPICA__PUBLIC_URL__;

export async function convertAsset(req, res) {
    Bucket.initialize({ apikey: `${process.env.API_KEY}` });
    const { git_username, git_email, git_repo_name, git_url, git_access_token, ignored_buckets, ignored_functions } = req.body;

    let GIT_USERNAME = git_username;
    let GIT_EMAIL = git_email;
    let GIT_REPO_NAME = git_repo_name;
    let GIT_ACCESS_TOKEN = git_access_token;
    let GIT_URL = git_url;

    let buckets_arr = ignored_buckets.split(",");
    let functions_arr = ignored_functions.split(",");

    let bucketIds = formatData(buckets_arr)
    let functionIds = formatData(functions_arr)

    /////////--------------Get Schemas-----------------////////////
    let schemas = await Bucket.getAll().catch(error =>
        console.log("get allBuckets error :", error)
    );
    /////////--------------Get Schemas-----------------////////////

    /////////--------------Get Functions with dependencies and environments-----------------////////////
    let allFunctions = await getAllFunctions().catch(error =>
        console.log("get allfunctions error :", error)
    );

    if (functionIds) {
        allFunctions = allFunctions.filter(f => {
            if (functionIds) {
                return !functionIds.includes(f._id);
            }
            return true;
        });
    }

    for (const fn of allFunctions) {
        await getIndexes(fn._id)
            .then(indexData => {
                fn.index = indexData.index;
            })
            .catch(error => console.log("getIndexes error :", error));
        await getDependencies(fn._id)
            .then(dependencies => {
                dependencies.map((item) => { if (item.types) delete item.types; return item })
                fn.dependencies = dependencies;
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
    let metadataNames = [];

    data.schemas = data.schemas.filter((s, i) => {
        setUnrealArray(s, i);
        if (bucketIds) {
            return !bucketIds.includes(s._id);
        }
        return true;
    });


    metadataNames = [];

    let originalBuckets = [];
    let withRelationBuckets = [];
    let withoutRelationBuckets = [];

    data.schemas = data.schemas.map((s, i) => {
        s = {
            apiVersion: "bucket/v1",
            kind: "Schema",
            metadata: {
                name: doUnreal(s.title, i, 'bucket')
            },
            spec: s
        };

        findRelation(s.spec.properties);
        function findRelation(props) {
            Object.keys(props).forEach((p) => {
                if (props[p].type == 'relation') {
                    props[p].bucket = {
                        resourceFieldRef: {
                            schemaName: schemaFindArr.filter(
                                f => f._id == props[p].bucketId
                            )[0].unrealName
                        }
                    };
                    delete props[p].bucketId;
                }
                if (props[p].type == 'object') {
                    findRelation(props[p].properties);
                }
                if (props[p].type == 'array') {
                    findRelation(props[p]);
                }
            });
        }

        delete s.spec._id;
        return s
    });

    function setUnrealArray(s, i) {

        let data = {
            _id: s._id,
            unrealName: doUnreal(s.title, i, 'bucket'),
            realName: s.title
        };
        schemaFindArr.push(data);
    }

    function doUnreal(word, i, type) {
        word =
            word
                .trim()
                .replace(/ /g, "-")
                .toLowerCase();
        if (metadataNames.includes(word)) {
            word += "-" + (i + 1) + `-${type}`
        } else {
            word += `-${type}`
        }

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

    data.allFunctions.forEach((f, i) => {
        envs = [];
        let unrealname = doUnreal(f.name, i, 'function');
        metadataNames.push(unrealname)

        Object.keys(f.env).forEach(e => {
            if (e == "_IGNORE_") isIgnore = true;
            envs.push({ name: e, value: f.env[e] });
        });
        if (envs.length > 0) f.environment = envs;
        delete f.env;
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
            case "schedule":
                t.scheduleOptions = t.options;
                break;
            case "system":
                t.systemOptions = t.options;
                break;
            case "firehose":
                t.firehoseOptions = t.options;
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

    /***********************GIT************************/
    await run("rm", ["-rf", "tmp/repo"]).catch(e => console.log("e :", e));

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
        .then(() => { })
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
    
    const scriptPath = "/tmp/installDependencies.sh";

    const scriptInstall = `apt-get update -y 
    apt-get install git -y`;

    console.log("INSTALLATION GIT START");

    fs.writeFileSync(scriptPath, scriptInstall);
    fs.chmodSync(scriptPath, "755");
    cp.spawn(scriptPath, [], {
        env: {},
        cwd: "/tmp",
        stdio: ["ignore", "inherit", "inherit"]
    });

    console.log("GIT INSTALLED");

    return {};
}

function formatData(data) {
    let str = "";

    for (let item of data) {
        str += idParser(item) + ",";
    }

    if (str.length > 0) {
        str = str.slice(0, -1);
    }

    return str;
}

function idParser(str) {
    var n = str.split(" ");
    return n[n.length - 1];
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

async function getAllFunctions() {
    return new Promise(async (resolve, reject) => {
        await fetch(`${PUBLIC_URL}/function/`, {
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
async function getIndexes(id) {
    return new Promise(async (resolve, reject) => {
        await fetch(`${PUBLIC_URL}/function/${id}/index`, {
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
async function getDependencies(id) {
    return new Promise(async (resolve, reject) => {
        await fetch(`${PUBLIC_URL}/function/${id}/dependencies`, {
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

export async function spicaToAssetDahsboard(req, res) {
    installGit();
    Bucket.initialize({ apikey: `${process.env.API_KEY}` });
    const [bucketIds] = await Bucket.getAll().then((buckets) =>
        buckets.reduce(
            (acc, curr) => {
                acc[0].push(`${curr.title} ${curr._id}`);

                return acc;
            },
            [[]]
        )
    );

    let db = await database().catch(err => console.log("Error", err))
    let functionCollection = db.collection('function')
    let functionsData = await functionCollection.find().toArray().catch(err => console.log("Error", err))

    functionsData = functionsData.map(fn => { return `${fn.name} ${fn._id}` })

    return {
        title: "Spica To Asset Dashboard",
        description:
            "Fill all fields to extract assets",
        inputs: [
            {
                key: "git_username",
                type: "string",
                value: "",
                title: "Git Username",
            },
            {
                key: "git_email",
                type: "string",
                value: "",
                title: "Git Email",
            },
            {
                key: "git_repo_name",
                type: "string",
                value: "",
                title: "Git Repo Name",
            },
            {
                key: "git_url",
                type: "string",
                value: "",
                title: "Git URL",
            },
            {
                key: "git_access_token",
                type: "string",
                value: "",
                title: "Git Access Token",
            },
            {
                key: "ignored_buckets",
                type: "multiselect",
                items: {
                    type: "string",
                    enum: Array.from(new Set(bucketIds)),
                },
                value: null,
                title: "Ignored Buckets",
            },
            {
                key: "ignored_functions",
                type: "multiselect",
                items: {
                    type: "string",
                    enum: functionsData,
                },
                value: null,
                title: "Ignored Functions",
            },

        ],
        button: {
            color: "primary",
            target: `${PUBLIC_URL}/fn-execute/convertAsset`,
            method: "post",
            title: "Send Request",
        },
    };
}
