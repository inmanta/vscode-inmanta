pipeline {
    agent any

    options{
        disableConcurrentBuilds()
    }

    triggers { 
        upstream "inmanta-core/master"
        cron("H H(2-5) * * *")
        pollSCM '* * * * *'
    }

    environment {
      INMANTA_TEST_ENV="${env.WORKSPACE}/env"
    } 

    stages {
        stage('Test') {
            steps {
                sh 'rm -rf $INMANTA_TEST_ENV; python3 -m venv $INMANTA_TEST_ENV; $INMANTA_TEST_ENV/bin/python3 -m pip install -U tox tox_venv'
                dir("server"){
                    sh "$INMANTA_TEST_ENV/bin/python3 -m tox --recreate"
                }
                sh 'rm -rf node_modules; npm i --also=dev; npm run test'
            }
        }
    }

    post {
        always {
            junit 'server/junit*.xml'
        }
    }
}  