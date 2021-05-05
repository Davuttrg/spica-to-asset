import * as Bucket from "@spica-devkit/bucket";
const fetch = require("node-fetch");
var YAML = require('json2yaml');


export async function convertAsset(req, res) {
  const { git_url } = req.query;
  Bucket.initialize({ apikey: `${process.env.API_KEY}` });
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

  let allYaml = [];
  let schemaFindArr = [];
  data.schemas.forEach((s, i) => {
    setUnrealArray(s, i);
  });
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
  data.schemas.forEach(s => allYaml.push(s));
  let triggers = [];
  let indexes = [];
  data.allFunctions = data.allFunctions.map((f, i) => {
    let unrealname = doUnreal(f.name, i);
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
    indexes.push({ function: unrealname, index: f.index });
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
    allYaml.push(f);
    return f;
  });
  //console.log()
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
    allYaml.push(t);

    return t;
  });
  console.log(allYaml);
  console.log(indexes)


  let yamlData = YAML.stringify(allyaml)
  if (dubRelation) return res.status(400).send({ message: "Dublicate relation error !" })
  return { yamlData };
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