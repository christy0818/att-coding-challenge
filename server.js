import cluster from 'cluster';
import os from 'os';
import express from 'express';
import {Observable} from 'rxjs/Observable';
import {RxHttpRequest} from 'rx-http-request';
const numCPUs = os.cpus().length - 1;
const serv = express(); //var app = express();
const GIT_AUTH_TOKEN = "token 2543af55859929948d7ca96d1aaaf9bb2d3da250";
const rxReauestOption = {
    headers: {'Authorization': GIT_AUTH_TOKEN,'User-Agent':'ATT-challenge'},
    json: true
};
///////////
function requestGetRepos(){
    return RxHttpRequest.get('https://api.github.com/orgs/att/repos', rxReauestOption)
};
function requestGetIssues(repoFullName){
    return RxHttpRequest.get(`https://api.github.com/repos/${repoFullName}/issues`, rxReauestOption);
}
function requestGetComments(commentsUrl){
    return RxHttpRequest.get(commentsUrl, rxReauestOption);
}
const getAllIssuesWithComments = (req, res ,next) => {
    requestGetRepos().subscribe((gitRes) => {
            if (gitRes.response.statusCode === 200) {
                // filter open repository (private = false),
                //and map the response body to create full_name list for all the open repository
                let allRepositoryFullName = gitRes.body.filter(body => !body.private ).map(body => body.full_name);
                splitIssuesToThreads(allRepositoryFullName, res);
            }
        },
        (err) => console.error(err) // Show error in console
        );
}
function splitIssuesToThreads(allRepositoryFullName, res) {
    if (cluster.isMaster) {
        masterProcess();
    } else {
        childProcess();
    }
    function masterProcess() {
        const workers = [];
        const promises = [];
        for (let i = 0; i < numCPUs; i++) {
            const worker = cluster.fork();
            workers.push(worker);
            promises.push(new Promise((resolve, reject) => {
                worker.on('message', function(result) {
                    resolve(result.allIssues);
                });
            }));
        }
        workers.forEach((worker, i) => {
            const requestPerCUP = allRepositoryFullName.length / numCPUs;
            console.log('requestPerCUP: ' + requestPerCUP);
            worker.send({ data: allRepositoryFullName.slice(i * requestPerCUP, i * requestPerCUP + requestPerCUP) });
        });
        Promise.all(promises)
            .then((data) => {
                    res.json(data.reduce((a, b) => {
                    return a.concat(b);
                }, []));
            });
    }
    function childProcess() {
        console.log(`Worker ${process.pid}`);
        process.on('message', function({data}) {
            let issuesObs = data.map(name => requestGetIssues(name));
            Observable.forkJoin(issuesObs)
                .subscribe(issuesRes => {
                    //remove response with no issues
                    let tmp = issuesRes.map(issuesRes => issuesRes.body).filter(i => i.length != 0);
                    //remove issues with no comments
                    let tmp2 = tmp.map(issues => issues.filter(issue => issue.comments >0));
                    //get comments url
                    let tmp3 = tmp2.map(issues => issues.map(issue => issue.comments_url));
                    // remove empty array
                    let tmp4 = tmp3.filter(t => t.length > 0);
                    // create an array for all comments url
                    let commentsUrls = [];
                    tmp4.map(urls => urls.forEach(url => commentsUrls.push(url)));
                    //create observables for each url
                    let commentsObs = commentsUrls.map(url => requestGetComments(url));
                    issuesRes = issuesRes.map(issuesRes => issuesRes.body)
                        .reduce((a, b) => {return a.concat(b)}, [])
                        .map(issue => {
                            return {
                                issue_url: issue.url,
                                issue_id: issue.id,
                                issue_title: issue.title,
                                comments_url: issue.comments_url
                            }
                    });
                    Observable.forkJoin(commentsObs)
                        .subscribe(commentsRes => {
                            let allCommentsResponse = [];
                            commentsRes = commentsRes.map(res => res.body);
                            issuesRes = issuesRes.map(issue => {
                                const comments = commentsRes.find((commentsArray) => {
                                    var comment = commentsArray[0];
                                    return comment.issue_url === issue.issue_url
                                }) || [];
                                return {
                                    issue_url: issue.issue_url,
                                    issue_id: issue.issue_id,
                                    issue_title: issue.issue_title,
                                    comments: comments
                                };
                            });
                            process.send({ allIssues: issuesRes });
                        })
                });
        });
    }
}
//GetRepos();
if (cluster.isMaster) {
    console.log("serving Restful API for ATT Coding Challenge...");
    serv.listen(3005);
    serv.get("/test", (req, res, next)=> {res.json({"hello world":1})});
    serv.get("/issues", getAllIssuesWithComments);
} else {
    splitIssuesToThreads();
}