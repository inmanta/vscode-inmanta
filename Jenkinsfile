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
      INMANTA_SERVER_PATH="${env.WORKSPACE}/server"
      INMANTA_PYTHON_PATH="${env.WORKSPACE}/env/bin/python3"
    } 

    stages {
        stage('Server tests') {
            steps {
                sh '''
                    rm -rf $INMANTA_TEST_ENV
                    python3 -m venv $INMANTA_TEST_ENV
                    $INMANTA_PYTHON_PATH -m pip install -U tox tox_venv
                '''
                dir("server"){
                    sh "$INMANTA_PYTHON_PATH -m tox --recreate"
                }
            }
        }
        stage('Extension tests') {
            steps {
                sh 'rm -rf node_modules'
                sh 'npm i --also=dev'
                sh '$INMANTA_PYTHON_PATH -m pip install -e $INMANTA_SERVER_PATH'
                sh 'INMANTA_COMPILER_VENV="" xvfb-run npm run test'
            }
        }
    }

    post {
        always {
            junit 'server/junit*.xml'
        }
    }
}  
