const express = require('express')
const formidableMiddleware = require('express-formidable');
const Sequelize = require('sequelize');

const sequelize = new Sequelize('sqlite:./sms.db')
const Op = Sequelize.Op

const app = express()
const port = 3000

app.use(formidableMiddleware())

const plivo = require('plivo')
const plivoClient = new plivo.Client() // uses PLIVO_AUTH_ID and PLIVO_AUTH_TOKEN from environment

const customerServiceNumber = "YOUR CUSTOMER SERVICE DEPARTMENT"
const exampleCustomerNumber = "EXAMPLE CUSTOMER NUMBER"
const baseURL = "YOUR FQDN HERE"

// set up the database
const Appointment = sequelize.define('appointment', {
  phoneNumber: { type: Sequelize.STRING },
  appointmentTime: { type: Sequelize.DATE },
  handymanPhone: { type: Sequelize.STRING }
});
// create mock appointment record
const createAppointment = () => {
  Appointment.findOrCreate({
    where: {phoneNumber: exampleCustomerNumber}, 
    defaults: {appointmentTime: Date.now(), handymanPhone: "16808001249"} 
  }).then(([appointment, created]) => {
    appointment.update({appointmentTime: Date.now()})
  })
}
createAppointment() 

// check for an appointment for today for a specific phone number
const hasAppointmentToday = async (phoneNumber) => {
  const start = new Date().setHours(0,0,0,0)
  const end = new Date().setHours(23,59,59,999)
  const appointment = await Appointment.findOne({
    where: {
      phoneNumber: phoneNumber,
      appointmentTime: {[Op.between]: [start, end]}
    }
  })

  if (appointment) {
    const handymanPhone = appointment.get({plain: true}).handymanPhone
    return {handymanPhone: handymanPhone}
  }else{
    return false
  }
}

const Call = sequelize.define('call', {
  uuid: { type: Sequelize.STRING },
  startTime: { type: Sequelize.STRING },
  from: { type: Sequelize.STRING },
  to: { type: Sequelize.STRING },
  direction: { type: Sequelize.STRING },
  duration: { type: Sequelize.STRING },
  cost: { type: Sequelize.DECIMAL },
  hangupCause: { type: Sequelize.STRING },
  hangupSource: { type: Sequelize.STRING }
});

const SurveyResult = sequelize.define('surveyResult', {
  customerPhone: { type: Sequelize.STRING },
  rating: { type: Sequelize.STRING }
});

// log calls
const logCall = (call) => {
  Call.create(call)
}

// log survey
const logSurveyResults = (survey) => {
  SurveyResult.create(survey)
}

// make sure the database is up to date, then start the server
sequelize.sync({alter: true}).then(() => {

  // answer incoming calls
  app.post('/incomingCall', async (req, res) => {

    const plivoResponse = plivo.Response()
      // check to see if there's an appointment for the calling customer for today
      const appointment = await hasAppointmentToday(req.fields.From)
 
      if (appointment) {
      // if an appointment is scheduled for today, play a special appointment IVR

      const ivr = plivoResponse.addGetDigits({
        action: `${baseURL}/appointmentIVR/${appointment.handymanPhone}`,
        method: 'POST',
        timeout: '5',
        numDigits: '1'
      })
      ivr.addSpeak(
        "Hi, thanks for calling!\
        Your scheduled appointment is today. To\
        speak with your handyman, press 1.\
        Otherwise press 2 to be connected to Customer\
        Service."
      )
    }else{
      // otherwise, forward the call to Customer Service
      plivoResponse.addSpeak("Please hold while we connect you to customer service.")
      const dial = plivoResponse.addDial()
      dial.addNumber(customerServiceNumber)
    }

    res.send(plivoResponse.toXML())
  })

  // handle digits from the appointment IVR
  app.post('/appointmentIVR/:handymanPhone', async (req, res) => {
    const plivoResponse = plivo.Response()
    plivoResponse.addSpeak("Please hold while we connect you.")
    const dial = plivoResponse.addDial()

    if (req.fields.Digits == 1) {
      dial.addNumber(req.params.handymanPhone)
    }else{
      dial.addNumber(customerServiceNumber)
    }

    res.send(plivoResponse.toXML())
  })

  // place a survey call
  app.post('/placeSurveyCall', async (req, res) => {
    const call = await plivoClient.calls.create(
      customerServiceNumber,
      req.fields.to,
      `${baseURL}/surveyCallAnswered`,
      {
        answerMethod: 'POST',
        hangup_url: `${baseURL}/hangup/`,
        hangup_method: 'POST'        
      }
    )
    res.send(call)
  })

  // handle answered survey calls
  app.post('/surveyCallAnswered', (req, res) => {
    const plivoResponse = plivo.Response()

    const survey = plivoResponse.addGetDigits({
      action: `${baseURL}/surveyResult`,
      method: 'POST',
      timeout: '5',
      numDigits: '1',
      validDigits: '12345'
    })
    survey.addSpeak(
      "Hi! You were recently visited by one of our handy men.\
      How many stars would you rate your experience? Using your keypad, \
      enter your rating between 1 and 5, where 1 is the lowest \
      and 5 is the highest."
    )

    res.send(plivoResponse.toXML())
  })

  // handle digits pressed in survey call
  app.post('/surveyResult', (req, res) => {
    const plivoResponse = plivo.Response()

    const emotion = parseInt(req.fields.Digits) > 3 ? "glad" : "sorry"
    plivoResponse.addSpeak(
      `Thanks, we value your feedback. \
       We're ${emotion} you had a ${req.fields.Digits} star experience. \
       We'll use your feedback to continue to improve!`
       )

    logSurveyResults({
      customerPhone: req.fields.To,
      rating: req.fields.Digits
    })

    res.send(plivoResponse.toXML())
  })

  // log completed calls
  app.post('/hangup', (req, res) => {
    console.log(req.fields)
    logCall({
      uuid: req.fields.CallUUID, 
      startTime: req.fields.StartTime,
      from: req.fields.From, 
      to: req.fields.To, 
      duration: req.fields.Duration, 
      cost: req.fields.TotalCost, 
      hangupCause: req.fields.HangupCauseName, 
      hangupSource: req.fields.HangupSource
    })
    res.send("OK")
  })

  app.listen(port, () => {
    console.log(`Voice app listening on port ${port}!`)
  })

})


