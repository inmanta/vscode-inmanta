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
      INMANTA_LS_TEST_ENV="${env.WORKSPACE}/ls-venv"
      INMANTA_LS_PATH="${env.WORKSPACE}/server"
      INMANTA_EXTENSION_TEST_ENV="${env.WORKSPACE}/extension-venv"
    } 

    stages {
        stage('Language server tests') {
            steps {
                sh '''
                    rm -rf $INMANTA_LS_TEST_ENV
                    python3 -m venv $INMANTA_LS_TEST_ENV
                    $INMANTA_LS_TEST_ENV/bin/python3 -m pip install -U tox tox_venv
                '''
                dir("server"){
                    sh "$INMANTA_LS_TEST_ENV/bin/python3 -m tox --recreate"
                }
            }
        }
        stage('Extension tests') {
            steps {
                sh '''
                    rm -rf node_modules
                    npm i --also=dev
                    rm -rf $INMANTA_EXTENSION_TEST_ENV
                    python3 -m venv $INMANTA_EXTENSION_TEST_ENV
                    INMANTA_PYTHON_PATH="$INMANTA_EXTENSION_TEST_ENV/bin/python3" xvfb-run npm run test
                '''
            }
        }
    }

    post {
        always {
            junit 'server/junit*.xml'
        }
    }
}  
