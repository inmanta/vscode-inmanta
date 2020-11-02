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
        stage('Server tests') {
            steps {
                sh 'rm -rf $INMANTA_TEST_ENV; python3 -m venv $INMANTA_TEST_ENV; $INMANTA_TEST_ENV/bin/python3 -m pip install -U tox tox_venv'
                dir("server"){
                    sh "$INMANTA_TEST_ENV/bin/python3 -m tox --recreate"
                }
            }
        }
        stage('Extension tests') {
            steps {
                sh 'rm -rf node_modules'
                sh 'npm i --also=dev'
                sh '$INMANTA_TEST_ENV/bin/python3 -m pip install -e "${env.WORKSPACE}/server"'
                sh 'INMANTA_PYTHON_PATH="$INMANTA_TEST_ENV/bin/python3" INMANTA_COMPILER_VENV="" xvfb-run npm run test'
            }
        }
    }

    post {
        always {
            junit 'server/junit*.xml'
        }
    }
}  
